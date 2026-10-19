import ts from "typescript";

import { PALETTE_TOKEN_KEYS } from "../../public/skins.js";
import { SKIN_IDS } from "./contracts.mjs";
import { resolveProductionSelection } from "./review-production.mjs";

const MODES = Object.freeze(["light", "dark"]);
const OLD_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const TARGET_NAME = "SKIN_PALETTES";

function bindingContainsTarget(bindingName) {
  if (ts.isIdentifier(bindingName)) return bindingName.text === TARGET_NAME;
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    return bindingName.elements.some(
      (element) => !ts.isOmittedExpression(element) && bindingContainsTarget(element.name),
    );
  }
  return false;
}

function statementDeclaresOrExportsTarget(statement) {
  if (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => bindingContainsTarget(declaration.name))
  ) {
    return true;
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name?.text === TARGET_NAME
  ) {
    return true;
  }
  if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    return (
      statement.importClause?.name?.text === TARGET_NAME ||
      (bindings !== undefined &&
        (ts.isNamespaceImport(bindings)
          ? bindings.name.text === TARGET_NAME
          : bindings.elements.some((element) => element.name.text === TARGET_NAME)))
    );
  }
  if (ts.isExportDeclaration(statement) && statement.exportClause) {
    return ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.some((element) => element.name.text === TARGET_NAME)
      : ts.isNamespaceExport(statement.exportClause) && statement.exportClause.name.text === TARGET_NAME;
  }
  return false;
}

function findPaletteInitializer(sourceFile) {
  const targetStatements = sourceFile.statements.filter(statementDeclaresOrExportsTarget);
  if (targetStatements.length !== 1 || !ts.isVariableStatement(targetStatements[0])) {
    throw new TypeError("beforeSource must contain one export const SKIN_PALETTES declaration");
  }
  const statement = targetStatements[0];
  const declarations = statement.declarationList.declarations.filter((declaration) =>
    bindingContainsTarget(declaration.name),
  );
  if (
    declarations.length !== 1 ||
    statement.declarationList.declarations.length !== 1 ||
    !ts.isIdentifier(declarations[0].name) ||
    declarations[0].name.text !== TARGET_NAME ||
    (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    throw new TypeError("SKIN_PALETTES must be a single-declaration exported const");
  }
  if (!declarations[0].initializer || !ts.isObjectLiteralExpression(declarations[0].initializer)) {
    throw new TypeError("SKIN_PALETTES must use a static object literal initializer");
  }
  return declarations[0].initializer;
}

function readStaticProperties(objectLiteral, label) {
  if (!ts.isObjectLiteralExpression(objectLiteral)) throw new TypeError(`${label} must be an object literal`);
  const properties = new Map();
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new TypeError(`${label} may contain only ordinary static property assignments`);
    }
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
      throw new TypeError(`${label} property names must be identifiers or string literals`);
    }
    if (properties.has(name.text)) throw new TypeError(`${label} has duplicate property ${name.text}`);
    properties.set(name.text, property);
  }
  return properties;
}

function assertExactKeys(properties, expectedKeys, label, optionalKeys = []) {
  const expected = new Set(expectedKeys);
  const optional = new Set(optionalKeys);
  for (const key of properties.keys()) {
    if (!expected.has(key) && !optional.has(key)) throw new TypeError(`${label} has unknown property ${key}`);
  }
  if (properties.size !== expectedKeys.length + [...optional].filter((key) => properties.has(key)).length) {
    throw new TypeError(`${label} has missing or extra properties`);
  }
  for (const key of expectedKeys) {
    if (!properties.has(key)) throw new TypeError(`${label} is missing property ${key}`);
  }
}

/** Build the exact palette source bytes implied by one complete, reviewed selection. */
export function buildProductionPaletteSource({ beforeSource, verifiedModel, selections } = {}) {
  if (!Buffer.isBuffer(beforeSource)) throw new TypeError("beforeSource must be a Buffer");
  const sourceBytes = Buffer.from(beforeSource);
  const sourceText = sourceBytes.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(sourceBytes)) {
    throw new TypeError("beforeSource must contain valid round-trippable UTF-8");
  }

  const sourceFile = ts.createSourceFile(
    "skin-palettes.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, " ");
    throw new TypeError(`beforeSource has a JavaScript syntax error: ${detail}`);
  }

  const selectedBySkin = new Map();
  for (const skinId of SKIN_IDS) {
    const candidateId = selections?.choices?.[skinId]?.candidateId;
    const { candidate } = resolveProductionSelection({ verifiedModel, selections, candidateId });
    if (candidate.skinId !== skinId) throw new TypeError(`selection for ${skinId} resolved to ${candidate.skinId}`);
    selectedBySkin.set(skinId, candidate);
  }

  const paletteProperties = readStaticProperties(findPaletteInitializer(sourceFile), TARGET_NAME);
  assertExactKeys(paletteProperties, SKIN_IDS, TARGET_NAME);

  const replacements = [];
  for (const skinId of SKIN_IDS) {
    const skinProperties = readStaticProperties(paletteProperties.get(skinId).initializer, `SKIN_PALETTES.${skinId}`);
    assertExactKeys(skinProperties, MODES, `SKIN_PALETTES.${skinId}`);
    const candidate = selectedBySkin.get(skinId);

    for (const mode of MODES) {
      const modeLabel = `SKIN_PALETTES.${skinId}.${mode}`;
      const modeProperties = readStaticProperties(skinProperties.get(mode).initializer, modeLabel);
      assertExactKeys(modeProperties, PALETTE_TOKEN_KEYS, modeLabel, ["chartSeries"]);
      for (const token of PALETTE_TOKEN_KEYS) {
        const initializer = modeProperties.get(token).initializer;
        if (!ts.isStringLiteral(initializer) || !OLD_HEX_COLOR.test(initializer.text)) {
          throw new TypeError(`${modeLabel}.${token} must be a hex color string literal`);
        }
        const newValue = candidate.modes?.[mode]?.[token];
        if (typeof newValue !== "string") throw new TypeError(`selected ${skinId}.${mode}.${token} must be a string`);
        replacements.push({
          start: initializer.getStart(sourceFile),
          end: initializer.getEnd(),
          literal: JSON.stringify(newValue),
        });
      }
    }
  }

  if (replacements.length !== SKIN_IDS.length * MODES.length * PALETTE_TOKEN_KEYS.length) {
    throw new TypeError("palette replacement count does not match the registered token matrix");
  }
  replacements.sort((left, right) => right.start - left.start);
  let output = sourceText;
  let nextStart = sourceText.length;
  for (const replacement of replacements) {
    if (replacement.end > nextStart) throw new TypeError("palette token source spans overlap");
    output = `${output.slice(0, replacement.start)}${replacement.literal}${output.slice(replacement.end)}`;
    nextStart = replacement.start;
  }
  return Buffer.from(output, "utf8");
}
