package onestorage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type Identity struct {
	Name      string `json:"name"`
	Email     string `json:"email"`
	Timestamp *int64 `json:"timestamp,omitempty"`
}
type CommitOptions struct {
	TargetBranch      string    `json:"target_branch"`
	CommitMessage     string    `json:"commit_message"`
	Author            Identity  `json:"author"`
	Committer         *Identity `json:"committer,omitempty"`
	ExpectedTargetSHA *string   `json:"expected_target_sha,omitempty"`
	BaseBranch        string    `json:"base_branch,omitempty"`
	BaseRef           string    `json:"base_ref,omitempty"`
	EphemeralBase     bool      `json:"ephemeral_base,omitempty"`
	Ephemeral         bool      `json:"ephemeral,omitempty"`
}
type file struct {
	Path      string `json:"path"`
	ContentID string `json:"content_id"`
	Operation string `json:"operation"`
	Mode      string `json:"mode,omitempty"`
	reader    io.Reader
}
type CommitBuilder struct {
	repo    *Repository
	options CommitOptions
	files   []file
	used    bool
}

func (r *Repository) CreateCommit(options CommitOptions) *CommitBuilder {
	return &CommitBuilder{repo: r, options: options}
}
func (b *CommitBuilder) AddFile(path string, content io.Reader, mode string) *CommitBuilder {
	if b.used {
		panic("builder already sent")
	}
	if mode == "" {
		mode = "100644"
	}
	b.files = append(b.files, file{path, strconv.Itoa(len(b.files)), "upsert", mode, content})
	return b
}
func (b *CommitBuilder) AddFileFromString(path, content string) *CommitBuilder {
	return b.AddFile(path, strings.NewReader(content), "100644")
}
func (b *CommitBuilder) DeleteFile(path string) *CommitBuilder {
	if b.used {
		panic("builder already sent")
	}
	b.files = append(b.files, file{Path: path, ContentID: strconv.Itoa(len(b.files)), Operation: "delete"})
	return b
}
func (b *CommitBuilder) DeleteDirectory(path string) *CommitBuilder { return b.DeleteFile(path) }
func chunks(encoder *json.Encoder, name, id string, reader io.Reader) error {
	buffer := make([]byte, 1024*1024)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			chunk := Options{"data": base64.StdEncoding.EncodeToString(buffer[:n]), "eof": false}
			if id != "" {
				chunk["content_id"] = id
			}
			if e := encoder.Encode(Options{name: chunk}); e != nil {
				return e
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	chunk := Options{"data": "", "eof": true}
	if id != "" {
		chunk["content_id"] = id
	}
	return encoder.Encode(Options{name: chunk})
}
func (r *Repository) stream(ctx context.Context, endpoint string, write func(*json.Encoder) error) (Result, error) {
	reader, writer := io.Pipe()
	defer reader.Close()
	done := make(chan error, 1)
	go func() { err := write(json.NewEncoder(writer)); writer.CloseWithError(err); done <- err }()
	response, err := r.Client.Raw(ctx, r.Path+"/"+endpoint, "POST", reader, http.Header{"Content-Type": []string{"application/x-ndjson"}}, r.ID, []string{"git:write"})
	if err != nil {
		reader.CloseWithError(err)
		return nil, err
	}
	defer response.Body.Close()
	reader.Close()
	if err = <-done; err != nil {
		return nil, err
	}
	var result Result
	err = json.NewDecoder(response.Body).Decode(&result)
	return result, err
}
func (b *CommitBuilder) Send(ctx context.Context) (Result, error) {
	if b.used {
		return nil, errors.New("builder already sent")
	}
	b.used = true
	return b.repo.stream(ctx, "commit-pack", func(encoder *json.Encoder) error {
		metadata := struct {
			CommitOptions
			Files []file `json:"files"`
		}{b.options, b.files}
		if err := encoder.Encode(Options{"metadata": metadata}); err != nil {
			return err
		}
		for _, f := range b.files {
			if f.Operation == "delete" {
				continue
			}
			if f.reader == nil {
				return errors.New("missing file reader")
			}
			if err := chunks(encoder, "blob_chunk", f.ContentID, f.reader); err != nil {
				return err
			}
		}
		return nil
	})
}
func (r *Repository) CreateDiffCommit(ctx context.Context, options CommitOptions, diff io.Reader) (Result, error) {
	return r.stream(ctx, "diff-commit", func(encoder *json.Encoder) error {
		if err := encoder.Encode(Options{"metadata": options}); err != nil {
			return err
		}
		return chunks(encoder, "diff_chunk", "", diff)
	})
}
func (r *Repository) RestoreCommit(ctx context.Context, options CommitOptions) (Result, error) {
	return r.stream(ctx, "restore-commit", func(encoder *json.Encoder) error { return encoder.Encode(Options{"metadata": options}) })
}
