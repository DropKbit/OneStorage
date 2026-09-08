export default async ({ dependencies }) => {
  const file = dependencies.build["index.html"];
  if (!file || file.binary) throw Error("Expected an HTML build artifact");
  return {
    logs: ["Build and lint completed; preparing preview"],
    artifacts: { "index.html": file.content },
  };
};
