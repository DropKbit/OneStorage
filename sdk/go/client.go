package onestorage

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Options map[string]any
type Result map[string]any
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("OneStorage HTTP %d: %s", e.Status, e.Message) }

type Client struct {
	Origin, Token string
	Signer        *Signer
	HTTP          *http.Client
}

func New(origin, token string) (*Client, error) {
	u, err := url.Parse(origin)
	if err != nil || u == nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid OneStorage origin")
	}
	return &Client{Origin: strings.TrimRight(origin, "/"), Token: token}, nil
}
func (c *Client) Raw(ctx context.Context, path, method string, body io.Reader, headers http.Header, repo string, scopes []string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.Origin+"/api"+path, body)
	if err != nil {
		return nil, err
	}
	request.Header = headers.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	token := c.Token
	if token == "" && c.Signer != nil {
		token, err = c.Signer.Token(repo, scopes)
		if err != nil {
			return nil, err
		}
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	transport := &http.Client{Timeout: 60 * time.Second}
	if c.HTTP != nil {
		*transport = *c.HTTP
	}
	transport.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := transport.Do(request)
	if err != nil {
		return nil, err
	}
	if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != 304 {
		defer response.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Error == "" {
			failure.Error = response.Status
		}
		return nil, &Error{response.StatusCode, failure.Error}
	}
	return response, nil
}
func (c *Client) request(ctx context.Context, path, method string, body any, repo string, scope string) (Result, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	response, err := c.Raw(ctx, path, method, reader, http.Header{"Content-Type": []string{"application/json"}}, repo, []string{scope})
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var result Result
	err = json.NewDecoder(io.LimitReader(response.Body, 64*1024*1024)).Decode(&result)
	return result, err
}
func query(options Options) string {
	q := url.Values{}
	for k, v := range options {
		if v == nil {
			continue
		}
		switch x := v.(type) {
		case []string:
			for _, s := range x {
				q.Add(k, s)
			}
		case []any:
			for _, s := range x {
				q.Add(k, fmt.Sprint(s))
			}
		default:
			q.Add(k, fmt.Sprint(v))
		}
	}
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}
func (c *Client) ListRepos(ctx context.Context, options Options) (Result, error) {
	return c.request(ctx, "/repos"+query(options), "GET", nil, "", "org:read")
}

// ResolveRepo resolves an immutable repository UUID to the current Git URLs.
// Supply repository as namespace/name to avoid the org:read listing for signers.
func (c *Client) ResolveRepo(ctx context.Context, id, repository string) (Result, error) {
	if c.Signer != nil && repository == "" {
		options := Options{}
		for {
			page, err := c.ListRepos(ctx, options)
			if err != nil {
				return nil, err
			}
			rows, _ := page["repositories"].([]any)
			for _, value := range rows {
				item, ok := value.(map[string]any)
				if ok && item["id"] == id {
					repository = fmt.Sprint(item["namespace"]) + "/" + fmt.Sprint(item["name"])
					break
				}
			}
			if repository != "" {
				break
			}
			cursor, _ := page["next_cursor"].(string)
			if cursor == "" {
				return nil, &Error{404, "Repository not found"}
			}
			options["cursor"] = cursor
		}
	}
	if repository == "" {
		repository = id
	}
	return c.request(ctx, "/repo-url/"+url.PathEscape(id), "GET", nil, repository, "git:read")
}
func (c *Client) CreateRepo(ctx context.Context, options Options) (Result, error) {
	input := Options{}
	for k, v := range options {
		input[k] = v
	}
	name, _ := input["name"].(string)
	if name == "" {
		name, _ = input["id"].(string)
	}
	if name == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		name = fmt.Sprintf("%x", b)
	}
	input["name"] = name
	repo := name
	if c.Signer != nil {
		repo = c.Signer.Issuer + "/" + name
	}
	data, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	scopes := []string{"repo:write"}
	if base, ok := input["base_repo"].(map[string]any); ok && base["id"] != nil {
		scopes = append(scopes, "git:read")
	}
	if base, ok := input["base_repo"].(Options); ok && base["id"] != nil {
		scopes = append(scopes, "git:read")
	}
	response, err := c.Raw(ctx, "/repos", "POST", bytes.NewReader(data), http.Header{"Content-Type": []string{"application/json"}}, repo, scopes)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var result Result
	err = json.NewDecoder(response.Body).Decode(&result)
	return result, err
}

type Repository struct {
	Client   *Client
	ID, Path string
}

func (c *Client) Repo(namespace, name string) *Repository {
	return &Repository{c, namespace + "/" + name, "/repos/" + url.PathEscape(namespace) + "/" + url.PathEscape(name)}
}
func (r *Repository) request(ctx context.Context, endpoint, method string, options Options, scope string) (Result, error) {
	path := r.Path
	if endpoint != "" {
		path += "/" + endpoint
	}
	var body any = options
	if method == "GET" {
		path += query(options)
		body = nil
	}
	if scope == "" {
		scope = "git:write"
		if method == "GET" || endpoint == "grep" {
			scope = "git:read"
		}
	}
	return r.Client.request(ctx, path, method, body, r.ID, scope)
}
func (r *Repository) GetFile(ctx context.Context, path string, options Options, headers http.Header, head bool) (*http.Response, error) {
	q := Options{"path": path}
	for k, v := range options {
		q[k] = v
	}
	method := "GET"
	if head {
		method = "HEAD"
	}
	return r.Client.Raw(ctx, r.Path+"/file"+query(q), method, nil, headers, r.ID, []string{"git:read"})
}
func (r *Repository) GetArchive(ctx context.Context, options Options) (*http.Response, error) {
	b, err := json.Marshal(options)
	if err != nil {
		return nil, err
	}
	return r.Client.Raw(ctx, r.Path+"/archive", "POST", bytes.NewReader(b), http.Header{"Content-Type": []string{"application/json"}}, r.ID, []string{"git:read"})
}
func (r *Repository) GitURL(namespace string, authenticated bool) (string, error) {
	if namespace != "" && namespace != "ephemeral" && namespace != "import" {
		return "", errors.New("invalid namespace")
	}
	suffix := ""
	if namespace != "" {
		suffix = "+" + namespace
	}
	u, err := url.Parse(r.Client.Origin + strings.TrimPrefix(r.Path, "/repos") + suffix + ".git")
	if err != nil {
		return "", err
	}
	if authenticated {
		token := r.Client.Token
		if token == "" && r.Client.Signer != nil {
			token, err = r.Client.Signer.Token(r.ID, []string{"git:read", "git:write"})
			if err != nil {
				return "", err
			}
		}
		if token == "" {
			return "", errors.New("no authentication configured")
		}
		u.User = url.UserPassword("x", token)
	}
	return u.String(), nil
}
