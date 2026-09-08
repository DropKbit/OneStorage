import { HTTPException } from "hono/http-exception";
import { reportGitFailure } from "./diagnostics";

/** A failed DO call does not prove that its ref transaction failed. Keep the
 * uncertainty explicit, and distinguish gateway failures from DO diagnostics. */
export async function confirmGitResponse(
  repoId: string,
  call: () => Promise<Response>,
) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    const incident = reportGitFailure(error, repoId, "gateway-receive");
    return Response.json(
      {
        error:
          "Git result could not be confirmed; inspect remote refs before retrying; incident " +
          incident,
        incident_id: incident,
      },
      { status: 503, headers: { "X-OneStorage-Incident": incident } },
    );
  }
}
