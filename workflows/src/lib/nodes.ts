import type { NodeSpec } from './workflow.js';

/** Where n8n reaches rg-tools inside the compose network. */
export const RG_TOOLS_URL = 'http://rg-tools:8080';

const PG = { postgres: { id: 'rg-postgres', name: 'RG Postgres' } };
const KEY = { httpHeaderAuth: { id: 'rg-tools-key', name: 'RG Tools Key' } };
const TG = { telegramApi: { id: 'rg-telegram', name: 'RG Telegram' } };

/** An n8n expression. */
export const expr = (e: string): string => `={{ ${e} }}`;

export function schedule(name: string, everyMinutes: number): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: everyMinutes }] } },
  };
}

export function executeTrigger(name = 'Run on demand'): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: 1.1,
    parameters: { inputSource: 'passthrough' },
  };
}

/**
 * Runs SQL with positional parameters ($1, $2, ...). `params` is the body of an n8n expression that
 * evaluates to an array, so values are always bound by the driver and never concatenated into the SQL.
 */
export function postgres(name: string, query: string, params?: string): NodeSpec {
  const options: Record<string, unknown> = {};
  if (params !== undefined) options.queryReplacement = expr(params);
  return {
    name,
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    parameters: { operation: 'executeQuery', query, options },
    credentials: PG,
  };
}

/** POST to an rg-tools route. `body` is the body of an n8n expression that evaluates to the JSON payload. */
export function http(name: string, route: string, body: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    parameters: {
      method: 'POST',
      url: `${RG_TOOLS_URL}${route}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr(`JSON.stringify(${body})`),
      options: { timeout: 60000 },
    },
    credentials: KEY,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
  };
}

export function code(name: string, js: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: js },
  };
}

export function codeEach(name: string, js: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: js },
  };
}

function condition(left: string, op: { type: string; operation: string; singleValue?: boolean }, right?: unknown) {
  return {
    id: `c-${Buffer.from(left + op.operation + String(right)).toString('hex').slice(0, 12)}`,
    leftValue: expr(left),
    rightValue: right,
    operator: op,
  };
}

const COND_OPTS = { caseSensitive: true, leftValue: '', typeValidation: 'loose' };

/** Output 0 is true, output 1 is false. */
export function ifNode(name: string, left: string, op: 'true' | 'false' | 'empty' | 'notEmpty' = 'true'): NodeSpec {
  const operator =
    op === 'true' || op === 'false'
      ? { type: 'boolean', operation: op, singleValue: true }
      : { type: 'string', operation: op, singleValue: true };
  return {
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: { conditions: { options: COND_OPTS, conditions: [condition(left, operator)], combinator: 'and' } },
  };
}

/** One output per rule value, compared with number equality. */
export function switchNumber(name: string, left: string, values: number[]): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    parameters: {
      rules: {
        values: values.map((v) => ({
          conditions: {
            options: COND_OPTS,
            conditions: [condition(left, { type: 'number', operation: 'equals' }, v)],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: String(v),
        })),
      },
    },
  };
}

/** One output per rule value, compared with string equality. */
export function switchString(name: string, left: string, values: string[]): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    parameters: {
      rules: {
        values: values.map((v) => ({
          conditions: {
            options: COND_OPTS,
            conditions: [condition(left, { type: 'string', operation: 'equals' }, v)],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: v,
        })),
      },
    },
  };
}

/** Answers a Telegram callback query so the button stops spinning. */
export function telegramAnswer(name: string, queryId: string, text: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    parameters: { resource: 'callback', operation: 'answerQuery', queryId: expr(queryId), additionalFields: { text } },
    credentials: TG,
    onError: 'continueRegularOutput',
  };
}

export function telegramTrigger(name: string, updates: string[]): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.telegramTrigger',
    typeVersion: 1.1,
    parameters: { updates, additionalFields: {} },
    credentials: TG,
    webhookId: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  };
}

export function executeWorkflow(name: string, workflowId: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    parameters: {
      source: 'database',
      workflowId: { __rl: true, value: workflowId, mode: 'id' },
      options: { waitForSubWorkflow: true },
    },
  };
}

/** Sends a Telegram message. Never fails the workflow: an alert that cannot be delivered must not break the stage. */
export function telegram(
  name: string,
  chatId: string,
  text: string,
  extra: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr(chatId),
      text: expr(text),
      additionalFields: { appendAttribution: false, ...extra },
      ...top,
    },
    credentials: TG,
    onError: 'continueRegularOutput',
  };
}

export function respond(name: string, code: number, body: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    parameters: { respondWith: 'json', responseBody: expr(body), options: { responseCode: code } },
  };
}

export function webhook(name: string, path: string): NodeSpec {
  return {
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: { rawBody: true } },
    webhookId: path.replace(/[^a-z0-9]+/gi, '-'),
  };
}

export function splitInBatches(name: string, size: number): NodeSpec {
  return { name, type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: { batchSize: size, options: {} } };
}

export function noOp(name: string): NodeSpec {
  return { name, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} };
}

export function errorTrigger(name = 'Error Trigger'): NodeSpec {
  return { name, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} };
}
