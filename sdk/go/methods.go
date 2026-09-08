package onestorage

import (
	"context"
	"net/url"
)

func (r *Repository) Get(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "", "GET", options, "")
}
func (r *Repository) Update(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "", "PATCH", options, "repo:write")
}
func (r *Repository) Delete(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "", "DELETE", options, "repo:write")
}
func (r *Repository) ListBranches(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "branches", "GET", options, "")
}
func (r *Repository) GetBranch(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "branch", "GET", options, "")
}
func (r *Repository) CreateBranch(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "branches/create", "POST", options, "")
}
func (r *Repository) DeleteBranch(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "branches", "DELETE", options, "")
}
func (r *Repository) ListTags(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "tags", "GET", options, "")
}
func (r *Repository) GetTag(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "tag", "GET", options, "")
}
func (r *Repository) CreateTag(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "tags", "POST", options, "")
}
func (r *Repository) ListCommits(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "commits", "GET", options, "")
}
func (r *Repository) GetCommit(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "commit", "GET", options, "")
}
func (r *Repository) GetDiff(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "diff", "GET", options, "")
}
func (r *Repository) DiffBranches(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "branches/diff", "GET", options, "")
}
func (r *Repository) ListFiles(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "files", "GET", options, "")
}
func (r *Repository) ListFilesMetadata(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "files/metadata", "GET", options, "")
}
func (r *Repository) Grep(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "grep", "POST", options, "git:read")
}
func (r *Repository) Blame(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "blame", "GET", options, "")
}
func (r *Repository) GetNote(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "notes", "GET", options, "")
}
func (r *Repository) CreateNote(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "notes", "POST", options, "")
}
func (r *Repository) DeleteNote(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "notes", "DELETE", options, "")
}
func (r *Repository) ListNotesRefs(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "notes/refs", "GET", options, "")
}
func (r *Repository) PreviewMerge(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "merge/preview", "GET", options, "")
}
func (r *Repository) MergeBranches(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "merge", "POST", options, "")
}
func (r *Repository) PullUpstream(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "pull-upstream", "POST", options, "")
}
func (r *Repository) SyncStatus(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "sync-status", "GET", options, "")
}
func (r *Repository) ConfigureUpstream(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "upstream", "PUT", options, "repo:write")
}
func (r *Repository) ListGitCredentials(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "git-credentials", "GET", options, "repo:write")
}
func (r *Repository) CreateGitCredential(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "git-credentials", "POST", options, "repo:write")
}
func (r *Repository) UpdateGitCredential(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "git-credentials", "PUT", options, "repo:write")
}
func (r *Repository) ListWebhooks(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "webhooks", "GET", options, "")
}
func (r *Repository) CreateWebhook(ctx context.Context, options Options) (Result, error) {
	return r.request(ctx, "webhooks", "POST", options, "")
}
func (r *Repository) AppendNote(ctx context.Context, options Options) (Result, error) {
	input := Options{"operation": "append"}
	for k, v := range options {
		input[k] = v
	}
	input["operation"] = "append"
	return r.CreateNote(ctx, input)
}
func (r *Repository) DeleteTag(ctx context.Context, name string, ephemeral bool) (Result, error) {
	return r.request(ctx, "tags/"+url.PathEscape(name)+query(Options{"ephemeral": ephemeral}), "DELETE", nil, "git:write")
}
func (r *Repository) DeleteGitCredential(ctx context.Context, id string) (Result, error) {
	return r.request(ctx, "git-credentials/"+url.PathEscape(id), "DELETE", nil, "repo:write")
}
func (r *Repository) DeleteWebhook(ctx context.Context, id string) (Result, error) {
	return r.request(ctx, "webhooks/"+url.PathEscape(id), "DELETE", nil, "git:write")
}

func (r *Repository) UnsetBaseRepo(ctx context.Context) (Result, error) {
	return r.request(ctx, "base", "DELETE", nil, "repo:write")
}
