// Validate the index selected in the Deploy form before migrating or publishing Workers.
export async function prepareSemanticIndex(
  main,
  run,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const binding = main.vectorize?.find((x) => x.binding === "CODE_VECTORS");
  if (main.ai?.binding !== "AI" || !binding?.index_name)
    throw Error("Workers AI and CODE_VECTORS bindings must be provisioned");
  const name = binding.index_name;
  const index = JSON.parse(await run(["vectorize", "get", name, "--json"]));
  if (index.config?.dimensions !== 1024 || index.config?.metric !== "cosine")
    throw Error(
      "CODE_VECTORS requires 1024 dimensions and cosine metric for @cf/baai/bge-m3. Select a matching index in the Deploy form; existing indexes are never deleted or replaced.",
    );
  const read = async () =>
    JSON.parse(await run(["vectorize", "list-metadata-index", name, "--json"]));
  let metadata = await read();
  const check = () => {
    const repo = metadata.find((x) => x.propertyName === "repo");
    if (repo && String(repo.indexType).toLowerCase() !== "string")
      throw Error("Vectorize repo metadata index must have string type");
    return !!repo;
  };
  if (check()) return;
  try {
    await run([
      "vectorize",
      "create-metadata-index",
      name,
      "--property-name",
      "repo",
      "--type",
      "string",
    ]);
  } catch (error) {
    metadata = await read();
    if (!check()) throw error;
  }
  // Vectorize schema mutations are asynchronous; never begin ingestion before filtering exists.
  for (let i = 0; i < 60; i++) {
    metadata = await read();
    if (check()) return;
    await wait(2000);
  }
  throw Error(
    "Vectorize metadata index is still provisioning. Retry deployment; resources were preserved.",
  );
}
