/**
 * ツール定義のJSON Schemaを各社が受け付ける形へ変換する。
 *
 * ツール定義は src/tools/tool-defs.js で「中立形式」（JSON Schema Draft相当）として
 * 1回だけ書き、ここでベンダー差を吸収する。定義を3つ書き分けると必ずズレるため。
 */

// GeminiのSchemaはOpenAPI 3.0のサブセットで、未知のキーがあると400になる。
// 受け付けるキーだけを通し、それ以外（pattern, minimum, additionalProperties, $schema等）は落とす。
const GEMINI_ALLOWED_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
]);

// GeminiのTypeは大文字のenum値で指定する。
const GEMINI_TYPES = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

/**
 * JSON SchemaをGeminiのSchema形式へ再帰的に変換する。
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_ALLOWED_KEYS.has(key)) continue;

    if (key === "type") {
      // 配列型（["string","null"]）は先頭を採用し、nullableで表現する。
      const raw = Array.isArray(value) ? value[0] : value;
      out.type = GEMINI_TYPES[String(raw).toLowerCase()] ?? "STRING";
      if (Array.isArray(value) && value.includes("null")) out.nullable = true;
      continue;
    }

    if (key === "items") {
      out.items = toGeminiSchema(value);
      continue;
    }

    if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, toGeminiSchema(sub)]),
      );
      continue;
    }

    out[key] = value;
  }

  // propertiesが空のOBJECTはGeminiが受け付けないため、型だけの器にしておく。
  if (out.type === "OBJECT" && !out.properties) {
    out.properties = {};
  }

  return out;
}

/**
 * OpenAIのfunction parametersはJSON Schemaをほぼそのまま受け付けるが、
 * strictモードを使わない場合でもトップレベルはobjectである必要がある。
 */
export function toOpenAiParameters(schema) {
  if (!schema || schema.type !== "object") {
    return { type: "object", properties: {} };
  }
  return schema;
}
