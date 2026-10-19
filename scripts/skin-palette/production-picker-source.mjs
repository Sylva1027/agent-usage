import ts from "typescript";

import { derivePaletteDeclarationsFromTokens } from "../../public/skins.js";

const COLOUR_TOKENS = Object.freeze({
  pageBackground: "--bg",
  panelBackground: "--neo-surface",
  controlBackground: "--control",
  text: "--ink",
  mutedText: "--muted",
  border: "--line",
  accent: "--blue",
  chartText: "--chart-text",
  chartLine: "--chart-line",
});

const ORIGINAL_COLOUR_TOKENS = Object.freeze([
  "pageBackground",
  "panelBackground",
  "controlBackground",
  "text",
  "mutedText",
  "border",
  "accent",
  "chartText",
  "chartLine",
  "series1",
  "series2",
  "series3",
  "chartSeries",
]);

const DECLARATION_NAME = "COLOUR_TOKENS";
const PREVIEW_FUNCTION_NAME = "previewTokens";
const DERIVATION_NAME = "derivePaletteDeclarationsFromTokens";
const IMPORT_STATEMENT = `import { ${DERIVATION_NAME} } from "./skins.js";`;

export function productionPickerPreviewTokens(runtime, skinId, mode) {
  const palette = runtime.paletteFor?.(skinId, mode);
  if (!palette?.tokens) return null;

  const declarations = derivePaletteDeclarationsFromTokens(palette.tokens, mode);
  if (!declarations) return null;
  const byCssVariable = Object.fromEntries(declarations);
  const tokens = {};
  for (const [key, cssVariable] of Object.entries(COLOUR_TOKENS)) {
    const value = byCssVariable[cssVariable];
    if (typeof value === "string" && value) tokens[key] = value;
  }
  return Object.keys(tokens).length ? tokens : null;
}

function bindingContainsName(bindingName, name) {
  if (ts.isIdentifier(bindingName)) return bindingName.text === name;
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    return bindingName.elements.some(
      (element) => !ts.isOmittedExpression(element) && bindingContainsName(element.name, name),
    );
  }
  return false;
}

function statementDeclaresName(statement, name) {
  if (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => bindingContainsName(declaration.name, name))
  ) {
    return true;
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
    return true;
  }
  if (!ts.isImportDeclaration(statement)) return false;

  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.name?.text === name) return true;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return clause.namedBindings.name.text === name;
  return clause.namedBindings.elements.some((element) => element.name.text === name);
}

function targetStatements(sourceFile, name) {
  return sourceFile.statements.filter((statement) => statementDeclaresName(statement, name));
}

function assertSingleConstArray(sourceFile) {
  const statements = targetStatements(sourceFile, DECLARATION_NAME);
  if (statements.length !== 1 || !ts.isVariableStatement(statements[0])) {
    throw new TypeError("beforeSource must contain one top-level const COLOUR_TOKENS declaration");
  }

  const statement = statements[0];
  const declarations = statement.declarationList.declarations.filter((declaration) =>
    bindingContainsName(declaration.name, DECLARATION_NAME),
  );
  if (
    declarations.length !== 1 ||
    statement.declarationList.declarations.length !== 1 ||
    !ts.isIdentifier(declarations[0].name) ||
    declarations[0].name.text !== DECLARATION_NAME ||
    (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    statement.modifiers?.length
  ) {
    throw new TypeError("COLOUR_TOKENS must be a single-declaration top-level const");
  }

  const initializer = declarations[0].initializer;
  if (
    !initializer ||
    !ts.isArrayLiteralExpression(initializer) ||
    initializer.elements.length !== ORIGINAL_COLOUR_TOKENS.length ||
    initializer.elements.some(
      (element, index) => !ts.isStringLiteral(element) || element.text !== ORIGINAL_COLOUR_TOKENS[index],
    )
  ) {
    throw new TypeError("COLOUR_TOKENS must match the original static string array");
  }
  return statement;
}

function assertOrdinaryPreviewFunction(sourceFile) {
  const statements = targetStatements(sourceFile, PREVIEW_FUNCTION_NAME);
  if (statements.length !== 1 || !ts.isFunctionDeclaration(statements[0])) {
    throw new TypeError("beforeSource must contain one top-level function previewTokens");
  }

  const declaration = statements[0];
  const expectedParameters = ["runtime", "skinId", "mode"];
  if (
    !declaration.name ||
    declaration.asteriskToken ||
    declaration.modifiers?.length ||
    declaration.typeParameters?.length ||
    declaration.type ||
    !declaration.body ||
    declaration.parameters.length !== expectedParameters.length ||
    declaration.parameters.some(
      (parameter, index) =>
        !ts.isIdentifier(parameter.name) ||
        parameter.name.text !== expectedParameters[index] ||
        parameter.dotDotDotToken ||
        parameter.questionToken ||
        parameter.initializer ||
        parameter.type,
    )
  ) {
    throw new TypeError("previewTokens must use its ordinary three-identifier function signature");
  }
  return declaration;
}

function assertNoDerivationBindingConflict(sourceFile) {
  if (targetStatements(sourceFile, DERIVATION_NAME).length > 0) {
    throw new TypeError(`${DERIVATION_NAME} already has a top-level binding`);
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    const namedBindings = statement.importClause.namedBindings;
    if (
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === DERIVATION_NAME)
    ) {
      throw new TypeError(`${DERIVATION_NAME} is already imported`);
    }
  }
}

function convertLineEndings(text, lineEnding) {
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function generatedColourTokens(lineEnding) {
  return convertLineEndings(`const COLOUR_TOKENS = ${JSON.stringify(COLOUR_TOKENS, null, 2)};`, lineEnding);
}

function generatedPreviewFunction(lineEnding) {
  const source = productionPickerPreviewTokens
    .toString()
    .replace(/^function productionPickerPreviewTokens/, `function ${PREVIEW_FUNCTION_NAME}`);
  return convertLineEndings(source, lineEnding);
}

/** Build the deterministic public picker source bytes for the shared pure preview function. */
export function buildProductionPickerSource({ beforeSource } = {}) {
  if (!Buffer.isBuffer(beforeSource)) throw new TypeError("beforeSource must be a Buffer");
  const sourceBytes = Buffer.from(beforeSource);
  const sourceText = sourceBytes.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(sourceBytes)) {
    throw new TypeError("beforeSource must contain valid round-trippable UTF-8");
  }

  const sourceFile = ts.createSourceFile("skin-picker.js", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, " ");
    throw new TypeError(`beforeSource has a JavaScript syntax error: ${detail}`);
  }

  assertNoDerivationBindingConflict(sourceFile);
  const colourTokensStatement = assertSingleConstArray(sourceFile);
  const previewFunction = assertOrdinaryPreviewFunction(sourceFile);
  const firstStatement = sourceFile.statements[0];
  if (!firstStatement) throw new TypeError("beforeSource has no top-level statement for the import insertion");

  const lineEnding = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const replacements = [
    {
      start: firstStatement.getStart(sourceFile),
      end: firstStatement.getStart(sourceFile),
      text: `${IMPORT_STATEMENT}${lineEnding}`,
    },
    {
      start: colourTokensStatement.getStart(sourceFile),
      end: colourTokensStatement.getEnd(),
      text: generatedColourTokens(lineEnding),
    },
    {
      start: previewFunction.getStart(sourceFile),
      end: previewFunction.getEnd(),
      text: generatedPreviewFunction(lineEnding),
    },
  ].sort((left, right) => right.start - left.start);

  let output = sourceText;
  let nextStart = sourceText.length;
  for (const replacement of replacements) {
    if (replacement.end > nextStart) throw new TypeError("picker source replacement spans overlap");
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
    nextStart = replacement.start;
  }
  return Buffer.from(output, "utf8");
}
