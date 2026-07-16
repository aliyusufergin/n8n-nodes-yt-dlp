export interface OptionRule {
  arity: number;
  classification: "node-controlled" | "pass" | "restricted";
  aliases?: string[];
  aliasOf?: string;
  reason?: string;
  sensitive?: boolean;
  valueKind?:
    | "compat-options"
    | "output-template"
    | "path-component"
    | "preset-alias";
  allowedValues?: string[];
  presetExpansions?: Record<string, string[]>;
}

export interface OptionCatalog {
  ytDlpVersion: string;
  options: Record<string, OptionRule>;
}

export interface ArgumentPolicyInput {
  arguments: string;
  nodeArguments: readonly string[];
  catalog: OptionCatalog;
  sensitiveArguments?: string;
  cookies?: string;
}

export interface ApprovedArguments {
  argv: string[];
  cookieContent?: string;
  secretValues: string[];
}

export class ArgumentValidationError extends Error {}

function validateTextInput(
  name: string,
  value: string,
  maximumBytes: number,
): void {
  if (value.includes("\0")) {
    throw new ArgumentValidationError(`${name} contains a NUL byte.`);
  }

  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new ArgumentValidationError(
      `${name} exceeds ${maximumBytes} UTF-8 bytes.`,
    );
  }
}

function extractCookieValues(cookieContent: string): string[] {
  const values: string[] = [];
  const lines = cookieContent.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    if (
      line.length === 0 ||
      (line.startsWith("#") && !line.startsWith("#HttpOnly_"))
    ) {
      continue;
    }

    const fields = line.split("\t");
    const domain = fields[0]?.replace(/^#HttpOnly_/u, "");
    const valid =
      fields.length === 7 &&
      domain !== undefined &&
      domain.length > 0 &&
      (fields[1] === "TRUE" || fields[1] === "FALSE") &&
      fields[2].startsWith("/") &&
      (fields[3] === "TRUE" || fields[3] === "FALSE") &&
      /^\d+$/u.test(fields[4]) &&
      fields[5].length > 0;

    if (!valid) {
      throw new ArgumentValidationError(
        `Cookies line ${index + 1} is not valid Netscape cookie data.`,
      );
    }

    if (fields[6].length > 0) {
      values.push(fields[6]);
    }
  }

  return values;
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let tokenStarted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      tokenStarted = true;
      continue;
    }

    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      tokenStarted = true;
      continue;
    }

    if (character === "\\" && quote !== "single") {
      index += 1;
      if (index >= line.length) {
        throw new ArgumentValidationError(
          "Arguments end with an incomplete escape.",
        );
      }
      if (line[index] === "\n") {
        continue;
      }
      if (line[index] === "\r" && line[index + 1] === "\n") {
        index += 1;
        continue;
      }
      token += line[index];
      tokenStarted = true;
      continue;
    }

    if (
      (quote === undefined && "|&;<>".includes(character)) ||
      (quote !== "single" && (character === "$" || character === "`"))
    ) {
      throw new ArgumentValidationError(
        "Shell operators and expansions are not supported.",
      );
    }

    if (/\s/u.test(character) && quote === undefined) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    token += character;
    tokenStarted = true;
  }

  if (quote !== undefined) {
    throw new ArgumentValidationError("Arguments contain an unclosed quote.");
  }

  if (tokenStarted) {
    tokens.push(token);
  }

  return tokens;
}

function validatePositionalInput(token: string): void {
  if (token === "-") {
    throw new ArgumentValidationError(
      "Reading a positional input from stdin is not supported.",
    );
  }

  if (/^file:/iu.test(token)) {
    throw new ArgumentValidationError("file: URLs are not supported.");
  }

  if (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token === "~" ||
    token.startsWith("~/")
  ) {
    throw new ArgumentValidationError("Local file inputs are not supported.");
  }
}

function validateOptionValue(
  optionName: string,
  value: string,
  rule: OptionRule,
): void {
  if (
    rule.valueKind === "compat-options" ||
    rule.valueKind === "preset-alias"
  ) {
    const allowedValues = new Set(rule.allowedValues ?? []);
    const components =
      rule.valueKind === "compat-options" ? value.split(",") : [value];
    if (components.some((component) => !allowedValues.has(component))) {
      throw new ArgumentValidationError(
        `The yt-dlp option ${optionName} contains a value that is not allowed by this toolchain version.`,
      );
    }
    return;
  }

  if (
    rule.valueKind === "path-component" &&
    (value.length === 0 ||
      value === "." ||
      value === ".." ||
      /[\\/]/u.test(value))
  ) {
    throw new ArgumentValidationError(
      `The yt-dlp option ${optionName} must be a safe path component.`,
    );
  }

  if (rule.valueKind !== "output-template") {
    return;
  }

  const typePrefix = value.match(/^[a-z]+(?:,[a-z]+)*:/u)?.[0];
  const template =
    typePrefix === undefined ? value : value.slice(typePrefix.length);
  const unsafe =
    template.length === 0 ||
    template === "-" ||
    template.startsWith("/") ||
    template === "~" ||
    template.startsWith("~/") ||
    /^[a-z]:[\\/]/iu.test(template) ||
    template.split("/").includes("..");

  if (unsafe) {
    throw new ArgumentValidationError(
      `The yt-dlp option ${optionName} must be a safe relative path beneath the output area.`,
    );
  }
}

function validateCatalogOptions(
  tokens: readonly string[],
  catalog: OptionCatalog,
  source: "normal" | "preset" | "sensitive",
  presetDepth = 0,
): string[] {
  if (tokens.length === 0 && source === "normal") {
    throw new ArgumentValidationError("At least one remote input is required.");
  }

  if (source === "normal" && /(^|\/)yt-dlp(?:\.exe)?$/iu.test(tokens[0])) {
    throw new ArgumentValidationError(
      "Arguments excludes the yt-dlp executable name.",
    );
  }

  let afterSeparator = false;
  let positionalInputCount = 0;
  const secretValues: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--" && !afterSeparator) {
      if (source !== "normal") {
        throw new ArgumentValidationError(
          source === "sensitive"
            ? "Sensitive Arguments cannot contain the -- separator."
            : "Preset expansions cannot contain the -- separator.",
        );
      }
      afterSeparator = true;
      continue;
    }

    if (afterSeparator || !token.startsWith("-") || token === "-") {
      if (source !== "normal") {
        throw new ArgumentValidationError(
          source === "sensitive"
            ? "Sensitive Arguments can contain only options and values."
            : "Preset expansions cannot contain positional inputs.",
        );
      }
      validatePositionalInput(token);
      positionalInputCount += 1;
      continue;
    }

    const optionName = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    const listedRule = catalog.options[optionName];
    if (listedRule === undefined) {
      throw new ArgumentValidationError(`Unknown yt-dlp option: ${optionName}`);
    }
    const rule =
      listedRule.aliasOf === undefined
        ? listedRule
        : (catalog.options[listedRule.aliasOf] ?? listedRule);

    if (rule.classification === "restricted") {
      throw new ArgumentValidationError(
        rule.reason ?? `The yt-dlp option ${optionName} is restricted.`,
      );
    }

    if (rule.classification === "node-controlled") {
      throw new ArgumentValidationError(
        `The yt-dlp option ${optionName} is controlled by the node.`,
      );
    }

    if (source !== "sensitive" && rule.sensitive === true) {
      throw new ArgumentValidationError(
        `The yt-dlp option ${optionName} must be supplied through yt-dlp Secrets.`,
      );
    }

    if (rule.arity > 0) {
      const values: string[] = [];
      if (token.includes("=")) {
        values.push(token.slice(token.indexOf("=") + 1));
      }

      while (values.length < rule.arity) {
        if (index + 1 >= tokens.length) {
          throw new ArgumentValidationError(
            rule.arity === 1
              ? `The yt-dlp option ${optionName} requires a value.`
              : `The yt-dlp option ${optionName} requires ${rule.arity} values.`,
          );
        }
        if (tokens[index + 1] !== "-" && tokens[index + 1].startsWith("-")) {
          throw new ArgumentValidationError(
            `The yt-dlp option ${optionName} cannot use another option as its value; use ${optionName}=VALUE for a literal value beginning with a dash.`,
          );
        }
        index += 1;
        values.push(tokens[index]);
      }

      validateOptionValue(optionName, values[0], rule);

      if (rule.valueKind === "preset-alias") {
        if (presetDepth >= 10) {
          throw new ArgumentValidationError(
            "Preset expansion depth exceeds the safety limit.",
          );
        }
        const expansion = rule.presetExpansions?.[values[0]];
        if (expansion === undefined) {
          throw new ArgumentValidationError(
            `Unknown preset expansion: ${values[0]}`,
          );
        }
        validateCatalogOptions(expansion, catalog, "preset", presetDepth + 1);
      }

      if (source === "sensitive") {
        secretValues.push(...values);
      }
    } else if (token.includes("=")) {
      throw new ArgumentValidationError(
        `The yt-dlp option ${optionName} does not accept a value.`,
      );
    }
  }

  if (source === "normal" && positionalInputCount === 0) {
    throw new ArgumentValidationError("At least one remote input is required.");
  }

  return secretValues;
}

function containsOption(
  tokens: readonly string[],
  catalog: OptionCatalog,
  canonicalName: string,
): boolean {
  return tokens.some((token) => {
    const optionName = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    const rule = catalog.options[optionName];
    return optionName === canonicalName || rule?.aliasOf === canonicalName;
  });
}

export function approveArguments(
  input: ArgumentPolicyInput,
): ApprovedArguments {
  validateTextInput("Arguments", input.arguments, 64 * 1024);
  validateTextInput(
    "Sensitive Arguments",
    input.sensitiveArguments ?? "",
    64 * 1024,
  );
  validateTextInput("Cookies", input.cookies ?? "", 10 * 1024 * 1024);

  const normalTokens = tokenize(input.arguments);
  validateCatalogOptions(normalTokens, input.catalog, "normal");

  const sensitiveTokens = tokenize(input.sensitiveArguments ?? "");
  const sensitiveSecretValues = validateCatalogOptions(
    sensitiveTokens,
    input.catalog,
    "sensitive",
  );
  if (
    containsOption(sensitiveTokens, input.catalog, "--username") &&
    !containsOption(sensitiveTokens, input.catalog, "--password")
  ) {
    throw new ArgumentValidationError(
      "A password is required with --username because interactive input is disabled.",
    );
  }
  if (
    containsOption(sensitiveTokens, input.catalog, "--ap-username") &&
    !containsOption(sensitiveTokens, input.catalog, "--ap-password")
  ) {
    throw new ArgumentValidationError(
      "A password is required with --ap-username because interactive input is disabled.",
    );
  }
  const secretValues = [
    ...sensitiveSecretValues,
    ...extractCookieValues(input.cookies ?? ""),
  ];
  const separatorIndex = normalTokens.indexOf("--");
  const mergedTokens =
    separatorIndex === -1
      ? [...normalTokens, ...sensitiveTokens]
      : [
          ...normalTokens.slice(0, separatorIndex),
          ...sensitiveTokens,
          ...normalTokens.slice(separatorIndex),
        ];

  return {
    argv: [...input.nodeArguments, ...mergedTokens],
    ...(input.cookies ? { cookieContent: input.cookies } : {}),
    secretValues,
  };
}
