package onestorage

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type RefPolicy struct {
	Pattern    string
	Operations []string
}

func (r RefPolicy) MarshalJSON() ([]byte, error) { return json.Marshal([]any{r.Pattern, r.Operations}) }

type Signer struct {
	Issuer, Subject, Algorithm, KeyID string
	PrivateKey                        []byte
	TTL                               time.Duration
	Refs                              []RefPolicy
}

func (s *Signer) Token(repo string, scopes []string) (string, error) {
	alg := s.Algorithm
	if alg == "" {
		alg = "ES256"
	}
	ttl := s.TTL
	if ttl == 0 {
		ttl = time.Hour
	}
	if ttl < time.Second || ttl > 365*24*time.Hour {
		return "", errors.New("invalid JWT TTL")
	}
	block, _ := pem.Decode(s.PrivateKey)
	if block == nil {
		return "", errors.New("invalid PEM key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		if k, e := x509.ParsePKCS1PrivateKey(block.Bytes); e == nil {
			key = k
		} else if k, e := x509.ParseECPrivateKey(block.Bytes); e == nil {
			key = k
		} else {
			return "", err
		}
	}
	header := map[string]any{"alg": alg, "typ": "JWT"}
	if s.KeyID != "" {
		header["kid"] = s.KeyID
	}
	subject := s.Subject
	if subject == "" {
		subject = "onestorage-go"
	}
	now := time.Now()
	claims := map[string]any{"iss": s.Issuer, "sub": subject, "iat": now.Unix(), "exp": now.Add(ttl).Unix(), "scopes": scopes}
	if repo != "" {
		claims["repo"] = repo
	}
	if s.Refs != nil {
		claims["refs"] = s.Refs
	}
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	value := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	var hash crypto.Hash
	var digest []byte
	switch alg {
	case "ES256", "RS256":
		hash = crypto.SHA256
		v := sha256.Sum256([]byte(value))
		digest = v[:]
	case "ES384":
		hash = crypto.SHA384
		v := sha512.Sum384([]byte(value))
		digest = v[:]
	case "ES512":
		hash = crypto.SHA512
		v := sha512.Sum512([]byte(value))
		digest = v[:]
	default:
		return "", errors.New("unsupported JWT algorithm")
	}
	var signature []byte
	if alg == "RS256" {
		k, ok := key.(*rsa.PrivateKey)
		if !ok || k.N.BitLen() < 2048 {
			return "", errors.New("RSA key must have at least 2048 bits")
		}
		signature, err = rsa.SignPKCS1v15(rand.Reader, k, hash, digest)
	} else {
		k, ok := key.(*ecdsa.PrivateKey)
		bits := map[string]int{"ES256": 256, "ES384": 384, "ES512": 521}[alg]
		if !ok || k.Curve.Params().BitSize != bits {
			return "", errors.New("JWT curve mismatch")
		}
		r, v, e := ecdsa.Sign(rand.Reader, k, digest)
		err = e
		if e == nil {
			width := (bits + 7) / 8
			signature = make([]byte, width*2)
			r.FillBytes(signature[:width])
			v.FillBytes(signature[width:])
		}
	}
	if err != nil {
		return "", err
	}
	return value + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}
func ValidateWebhook(payload []byte, headers http.Header, secret string, tolerance time.Duration) (map[string]any, error) {
	if tolerance == 0 {
		tolerance = 5 * time.Minute
	}
	stamp := headers.Get("X-OneStorage-Timestamp")
	timestamp, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil {
		return nil, errors.New("invalid webhook timestamp")
	}
	delta := time.Since(time.Unix(timestamp, 0))
	if delta > tolerance || delta < -tolerance {
		return nil, errors.New("expired webhook")
	}
	supplied := headers.Get("X-OneStorage-Signature")
	if !strings.HasPrefix(supplied, "sha256=") {
		return nil, errors.New("missing webhook signature")
	}
	actual, err := hex.DecodeString(strings.TrimPrefix(supplied, "sha256="))
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stamp + "."))
	mac.Write(payload)
	if !hmac.Equal(actual, mac.Sum(nil)) {
		return nil, errors.New("invalid webhook signature")
	}
	var event map[string]any
	err = json.Unmarshal(payload, &event)
	return event, err
}
