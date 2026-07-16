const ARG_PATTERN = /^\s*ARG\s+([A-Z0-9_]+)(?:=(.*))?\s*$/gmu;
const VARIABLE_PATTERN = /\$(?:\{([A-Z0-9_]+)\}|([A-Z0-9_]+))/gu;

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseArguments(recipe) {
  const argumentsByName = new Map();

  for (const match of recipe.matchAll(ARG_PATTERN)) {
    argumentsByName.set(match[1], unquote((match[2] ?? "").trim()));
  }

  return argumentsByName;
}

function resolveValue(value, argumentsByName, resolving = new Set()) {
  return value.replace(VARIABLE_PATTERN, (_match, bracedName, plainName) => {
    const name = bracedName ?? plainName;

    if (!argumentsByName.has(name)) {
      throw new Error(`Unable to resolve build argument ${name}`);
    }

    if (resolving.has(name)) {
      throw new Error(`Circular build argument reference: ${name}`);
    }

    return resolveValue(
      argumentsByName.get(name),
      argumentsByName,
      new Set([...resolving, name]),
    );
  });
}

function referencedVariables(command, suffix) {
  const names = new Set();

  for (const match of command.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? match[2];

    if (name.endsWith(suffix)) {
      names.add(name);
    }
  }

  return [...names];
}

function networkVariables(command, argumentsByName) {
  const variables = new Map();

  for (const match of command.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (!argumentsByName.has(name)) continue;
    const value = resolveValue(argumentsByName.get(name), argumentsByName);
    if (/^(?:https?|git):\/\/|^git@/u.test(value)) variables.set(name, value);
  }

  return variables;
}

function cloneUrls(recipe, argumentsByName) {
  const urls = [];

  for (const line of recipe.split("\n")) {
    if (!/\bgit\s+clone\b/u.test(line)) continue;

    const variables = [...networkVariables(line, argumentsByName).values()];
    if (variables.length > 0) {
      urls.push(...variables);
      continue;
    }

    const match = line.match(
      /\bgit\s+clone\b.*?((?:https?|git):\/\/[^\s"']+|git@[^\s"']+)/u,
    );
    if (match) urls.push(match[1]);
    else throw new Error(`Unable to audit git clone: ${line.trim()}`);
  }

  return urls;
}

export function inspectSourceRecipe(recipe, reviewedGitSources) {
  const argumentsByName = parseArguments(recipe);
  const archives = [];

  for (const line of recipe.split("\n")) {
    if (!/\b(?:wget|curl)\b/u.test(line)) continue;

    const hiddenNetworkVariables = [
      ...networkVariables(line, argumentsByName).keys(),
    ].filter((name) => !name.endsWith("_URL"));
    if (hiddenNetworkVariables.length > 0) {
      throw new Error(
        `Found unreviewed network variable: ${hiddenNetworkVariables.join(", ")}`,
      );
    }
    const urlNames = referencedVariables(line, "_URL");
    if (urlNames.length === 0 && /https?:\/\//u.test(line)) {
      throw new Error(`Found unreviewed direct download: ${line.trim()}`);
    }

    for (const urlName of urlNames) {
      const name = urlName.slice(0, -4);
      const shaName = `${name}_SHA256`;
      const sha256 = argumentsByName.get(shaName);

      if (!sha256 || !/^[a-f0-9]{64}$/iu.test(sha256)) {
        throw new Error(
          `${urlName} must have a paired SHA-256 build argument named ${shaName}`,
        );
      }

      archives.push({
        name,
        sha256: sha256.toLowerCase(),
        url: resolveValue(argumentsByName.get(urlName), argumentsByName),
        version: argumentsByName.get(`${name}_VERSION`) ?? null,
      });
    }
  }

  const gitSources = cloneUrls(recipe, argumentsByName).map((url) => {
    const reviewed = reviewedGitSources.find((source) => source.url === url);

    if (!reviewed) {
      throw new Error(`Found unreviewed git clone: ${url}`);
    }

    const pinnedCommit = [...argumentsByName.values()].some(
      (value) => value.toLowerCase() === reviewed.commit.toLowerCase(),
    );
    if (!pinnedCommit) {
      throw new Error(
        `The reviewed commit for ${reviewed.name} is not pinned by the recipe`,
      );
    }

    return reviewed;
  });

  return { archives, gitSources };
}
