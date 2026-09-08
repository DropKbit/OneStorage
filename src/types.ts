export interface Env {
  DB: D1Database;
  OBJECTS: R2Bucket;
  REPOSITORIES: DurableObjectNamespace;
  ASSETS: Fetcher;
  EVENTS?: Queue<{ id: string }>;
  WEBHOOK_ALLOWED_HOSTS?: string;
  APP_ORIGIN: string;
  BOOTSTRAP_SECRET: string;
}
export interface User {
  id: string;
  username: string;
  admin: number;
}
export interface Repo {
  id: string;
  owner_id: string;
  namespace: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  default_branch: string;
  created_at: string;
}
export type App = {
  Bindings: Env;
  Variables: {
    user: User | null;
    scope: "read" | "write";
    kind: "pat" | "session" | null;
    credential: string | null;
  };
};
