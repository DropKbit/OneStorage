import { boundedBody } from "./security";
import { webhookURL } from "./webhooks";
export function endpoint(url: string, hosts: string[]) {
  const result = webhookURL(url, hosts.join(","));
  if (new URL(result).search)
    throw Error("Identity endpoints cannot contain query parameters");
  return result;
}
export async function identityJSON(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("Identity provider request failed");
  }
  return JSON.parse(
    new TextDecoder().decode(await boundedBody(response, 65536)),
  );
}
