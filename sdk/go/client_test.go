package onestorage

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"
)

func TestJWT(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	signer := &Signer{Issuer: "owner", PrivateKey: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})}
	token, err := signer.Token("owner/repo", []string{"git:read"})
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(&key.PublicKey, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		t.Fatal("JWT signature failed")
	}
}
func TestIntegration(t *testing.T) {
	origin := os.Getenv("TEST_ORIGIN")
	if origin == "" {
		t.Skip("local origin required")
	}
	client, err := New(origin, "")
	if err != nil {
		t.Fatal(err)
	}
	client.Signer = &Signer{Issuer: os.Getenv("TEST_ISSUER"), PrivateKey: []byte(os.Getenv("TEST_PRIVATE_KEY")), KeyID: os.Getenv("TEST_KEY_ID")}
	ctx := context.Background()
	project, err := client.CreateRepo(ctx, Options{"name": fmt.Sprintf("e2e_sdk_go_%d", time.Now().UnixNano())})
	if err != nil {
		t.Fatal(err)
	}
	repo := client.Repo(project["namespace"].(string), project["name"].(string))
	defer repo.Delete(ctx, nil)
	resolved, err := client.ResolveRepo(ctx, project["id"].(string), "")
	if err != nil || resolved["id"] != project["id"] {
		t.Fatal(resolved, err)
	}
	commit, err := repo.CreateCommit(CommitOptions{TargetBranch: "main", CommitMessage: "Go SDK", Author: Identity{Name: "Go", Email: "go@example.com"}}).AddFileFromString("README.md", "Go\n").AddFile("binary", bytes.NewReader([]byte{0, 1, 255}), "100644").Send(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if commit["sha"] == nil {
		t.Fatal("missing commit")
	}
	file, err := repo.GetFile(ctx, "binary", nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(file.Body)
	file.Body.Close()
	if !bytes.Equal(data, []byte{0, 1, 255}) {
		t.Fatal("binary mismatch")
	}
	if _, err = repo.CreateNote(ctx, Options{"sha": commit["sha"], "note": "verified"}); err != nil {
		t.Fatal(err)
	}
	note, err := repo.GetNote(ctx, Options{"sha": commit["sha"]})
	if err != nil || note["note"] != "verified\n" {
		t.Fatal(note, err)
	}
	if _, err = repo.CreateBranch(ctx, Options{"target_branch": "agent", "base_branch": "main", "ephemeral": true}); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.ListBranches(ctx, Options{"ephemeral": true}); err != nil {
		t.Fatal(err)
	}
}
