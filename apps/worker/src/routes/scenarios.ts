import { Hono } from 'hono';
import {
  getScenarios,
  getScenarioById,
  createScenario,
  updateScenario,
  deleteScenario,
  createScenarioStep,
  updateScenarioStep,
  deleteScenarioStep,
  enrollFriendInScenario,
  getFriendById,
  computeNextDeliveryAt,
} from '@line-crm/db';
import { computeScenarioStats } from '../services/scenario-stats.js';
import { resolveStepContent } from '@line-crm/db';
import { ensureSupportFriendAccess } from './support-friend-access.js';
import { requireRole } from '../middleware/role-guard.js';
import type {
  Scenario as DbScenario,
  ScenarioWithStepCount as DbScenarioWithStepCount,
  ScenarioStep as DbScenarioStep,
  FriendScenario as DbFriendScenario,
  ScenarioTriggerType,
  MessageType,
  DeliveryMode,
} from '@line-crm/db';
import type { Env } from '../index.js';

const scenarios = new Hono<Env>();

/** Convert D1 snake_case Scenario row to shared camelCase shape */
function serializeScenario(row: DbScenario) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerTagId: row.trigger_tag_id,
    // null = global scenario (fires for every account); UUID = bound to that line_account_id.
    // Surfacing this lets the dashboard distinguish "全アカ共通" from orphan scenarios whose
    // owner account was deleted.
    lineAccountId: (row as { line_account_id?: string | null }).line_account_id ?? null,
    isActive: Boolean(row.is_active),
    deliveryMode: (row.delivery_mode ?? 'relative') as DeliveryMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert D1 snake_case ScenarioStep row to shared camelCase shape */
function serializeStep(row: DbScenarioStep) {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    stepOrder: row.step_order,
    delayMinutes: row.delay_minutes,
    offsetDays: row.offset_days ?? null,
    offsetMinutes: row.offset_minutes ?? null,
    deliveryTime: row.delivery_time ?? null,
    messageType: row.message_type,
    messageContent: row.message_content,
    conditionType: row.condition_type ?? null,
    conditionValue: row.condition_value ?? null,
    nextStepOnFalse: row.next_step_on_false ?? null,
    templateId: row.template_id ?? null,
    onReachTagId: row.on_reach_tag_id ?? null,
    createdAt: row.created_at,
  };
}

const VALID_DELIVERY_MODES: readonly DeliveryMode[] = ['relative', 'elapsed', 'absolute_time'];
const VALID_TRIGGER_TYPES: readonly ScenarioTriggerType[] = ['friend_add', 'tag_added', 'manual'];
const VALID_MESSAGE_TYPES: readonly MessageType[] = ['text', 'image', 'flex'];
const VALID_CONDITION_TYPES = [
  'tag_exists',
  'tag_not_exists',
  'metadata_equals',
  'metadata_not_equals',
] as const;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCENARIO_NAME_MAX_LENGTH = 120;
const SCENARIO_DESCRIPTION_MAX_LENGTH = 2048;
const ID_MAX_LENGTH = 128;
const MESSAGE_CONTENT_MAX_LENGTH = 64 * 1024;
const IMAGE_URL_MAX_LENGTH = 2048;
const CONDITION_VALUE_MAX_LENGTH = 16 * 1024;
const STEP_ORDER_MAX = 10_000;
const DELAY_MINUTES_MAX = 10 * 365 * 24 * 60;
const OFFSET_DAYS_MAX = 3650;
const REORDER_MAX_ITEMS = 1000;
const DATE_CURSOR_MAX_LENGTH = 64;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ConditionType = (typeof VALID_CONDITION_TYPES)[number];
type ParseResult<T> = { ok: true; body: T } | { ok: false; error: string };
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface ScenarioCreateBody {
  name: string;
  description?: string | null;
  triggerType: ScenarioTriggerType;
  triggerTagId?: string | null;
  isActive?: boolean;
  lineAccountId?: string | null;
  deliveryMode: DeliveryMode;
}

interface ScenarioUpdateBody {
  name?: string;
  description?: string | null;
  triggerType?: ScenarioTriggerType;
  triggerTagId?: string | null;
  isActive?: boolean;
}

interface ScenarioStepCreateBody extends StepScheduleBody {
  stepOrder: number;
  messageType: MessageType;
  messageContent: string;
  conditionType?: ConditionType | null;
  conditionValue?: string | null;
  nextStepOnFalse?: number | null;
  templateId?: string | null;
  onReachTagId?: string | null;
}

interface ScenarioStepUpdateBody extends StepScheduleBody {
  stepOrder?: number;
  messageType?: MessageType;
  messageContent?: string;
  conditionType?: ConditionType | null;
  conditionValue?: string | null;
  nextStepOnFalse?: number | null;
  templateId?: string | null;
  onReachTagId?: string | null;
}

interface StepReorderBody {
  orders: { stepId: string; stepOrder: number }[];
}

interface StepScheduleBody {
  delayMinutes?: number;
  offsetDays?: number;
  offsetMinutes?: number;
  deliveryTime?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseRequiredString(raw: unknown, label: string, maxLength: number): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseVisibleId(raw: unknown, label: string): ValueResult<string> {
  const parsed = parseRequiredString(raw, label, ID_MAX_LENGTH);
  if (!parsed.ok) return parsed;
  if (!VISIBLE_ASCII_PATTERN.test(parsed.value)) return { ok: false, error: `${label} is invalid` };
  return parsed;
}

function parseOptionalVisibleId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > ID_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  if (!VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalDateCursor(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > DATE_CURSOR_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  if (!value.includes('T') || !Number.isFinite(new Date(value).getTime())) {
    return { ok: false, error: `${label} is invalid` };
  }
  return { ok: true, value };
}

function parseOptionalNullableString(
  raw: unknown,
  label: string,
  maxLength: number,
): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseOptionalBoolean(raw: unknown, label: string): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: `${label} must be a boolean` };
  return { ok: true, value: raw };
}

function parseEnumValue<T extends string>(
  raw: unknown,
  label: string,
  values: readonly T[],
  required: true,
): ValueResult<T>;
function parseEnumValue<T extends string>(
  raw: unknown,
  label: string,
  values: readonly T[],
  required: false,
): ValueResult<T | undefined>;
function parseEnumValue<T extends string>(
  raw: unknown,
  label: string,
  values: readonly T[],
  required: boolean,
): ValueResult<T | undefined> {
  if (raw === undefined && !required) return { ok: true, value: undefined };
  const parsed = parseRequiredString(raw, label, 64);
  if (!parsed.ok) return parsed;
  if (!values.includes(parsed.value as T)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value: parsed.value as T };
}

function parseInteger(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  required: true,
): ValueResult<number>;
function parseInteger(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  required: false,
): ValueResult<number | undefined>;
function parseInteger(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  required: boolean,
): ValueResult<number | undefined> {
  if (raw === undefined && !required) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !Number.isFinite(raw)) {
    return { ok: false, error: `${label} must be an integer` };
  }
  if (raw < min || raw > max) return { ok: false, error: `${label} is out of range` };
  return { ok: true, value: raw };
}

function parseOptionalNullableInteger(
  raw: unknown,
  label: string,
  min: number,
  max: number,
): ValueResult<number | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  return parseInteger(raw, label, min, max, true);
}

function parseOptionalScheduleString(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  return parseRequiredString(raw, label, 5);
}

function parseJsonRecord(raw: string, label: string): ValueResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${label} must be valid JSON` };
  }
  if (!isRecord(parsed)) return { ok: false, error: `${label} must be a JSON object` };
  return { ok: true, value: parsed };
}

function validateMessageContent(
  messageType: MessageType,
  messageContent: string,
): { ok: true } | { ok: false; error: string } {
  if (messageType === 'image') {
    const parsed = parseJsonRecord(messageContent, 'messageContent');
    if (!parsed.ok) return parsed;
    for (const key of ['originalContentUrl', 'previewImageUrl']) {
      const value = parsed.value[key];
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, error: `messageContent.${key} is required` };
      }
      if (value.length > IMAGE_URL_MAX_LENGTH) {
        return { ok: false, error: `messageContent.${key} is too long` };
      }
    }
  }
  if (messageType === 'flex') {
    const parsed = parseJsonRecord(messageContent, 'messageContent');
    if (!parsed.ok) return parsed;
  }
  return { ok: true };
}

function parseMessageContent(
  raw: unknown,
  messageType: MessageType | undefined,
  required: true,
): ValueResult<string>;
function parseMessageContent(
  raw: unknown,
  messageType: MessageType | undefined,
  required: false,
): ValueResult<string | undefined>;
function parseMessageContent(
  raw: unknown,
  messageType: MessageType | undefined,
  required: boolean,
): ValueResult<string | undefined> {
  if (raw === undefined && !required) return { ok: true, value: undefined };
  const parsed = parseRequiredString(raw, 'messageContent', MESSAGE_CONTENT_MAX_LENGTH);
  if (!parsed.ok) return parsed;
  if (messageType !== undefined) {
    const content = validateMessageContent(messageType, parsed.value);
    if (!content.ok) return content;
  }
  return { ok: true, value: parsed.value };
}

function parseConditionType(raw: unknown): ValueResult<ConditionType | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  const parsed = parseRequiredString(raw, 'conditionType', 64);
  if (!parsed.ok) return parsed;
  if (!VALID_CONDITION_TYPES.includes(parsed.value as ConditionType)) {
    return { ok: false, error: 'conditionType is invalid' };
  }
  return { ok: true, value: parsed.value as ConditionType };
}

function validateConditionValue(
  conditionType: ConditionType,
  conditionValue: string,
): { ok: true } | { ok: false; error: string } {
  if (conditionType === 'metadata_equals' || conditionType === 'metadata_not_equals') {
    const parsed = parseJsonRecord(conditionValue, 'conditionValue');
    if (!parsed.ok) return parsed;
    if (typeof parsed.value.key !== 'string' || !Object.prototype.hasOwnProperty.call(parsed.value, 'value')) {
      return { ok: false, error: 'conditionValue must include key and value' };
    }
  }
  return { ok: true };
}

function parseConditionValue(raw: unknown): ValueResult<string | null | undefined> {
  return parseOptionalNullableString(raw, 'conditionValue', CONDITION_VALUE_MAX_LENGTH);
}

function parseScenarioCreateBody(raw: unknown): ParseResult<ScenarioCreateBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseRequiredString(raw.name, 'name', SCENARIO_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const description = parseOptionalNullableString(raw.description, 'description', SCENARIO_DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;
  const triggerType = parseEnumValue(raw.triggerType, 'triggerType', VALID_TRIGGER_TYPES, true);
  if (!triggerType.ok) return triggerType;
  const triggerTagId = parseOptionalNullableString(raw.triggerTagId, 'triggerTagId', ID_MAX_LENGTH);
  if (!triggerTagId.ok) return triggerTagId;
  const isActive = parseOptionalBoolean(raw.isActive, 'isActive');
  if (!isActive.ok) return isActive;
  const lineAccountId = parseOptionalNullableString(raw.lineAccountId, 'lineAccountId', ID_MAX_LENGTH);
  if (!lineAccountId.ok) return lineAccountId;
  const deliveryMode = raw.deliveryMode === undefined
    ? { ok: true as const, value: 'relative' as DeliveryMode }
    : parseEnumValue(raw.deliveryMode, 'deliveryMode', VALID_DELIVERY_MODES, true);
  if (!deliveryMode.ok) return deliveryMode;
  return {
    ok: true,
    body: {
      name: name.value,
      description: description.value,
      triggerType: triggerType.value,
      triggerTagId: triggerTagId.value,
      isActive: isActive.value,
      lineAccountId: lineAccountId.value,
      deliveryMode: deliveryMode.value,
    },
  };
}

function parseScenarioUpdateBody(raw: unknown): ParseResult<ScenarioUpdateBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  if (raw.deliveryMode !== undefined) {
    return { ok: false, error: 'deliveryMode cannot be changed after creation' };
  }
  const name = raw.name === undefined
    ? { ok: true as const, value: undefined }
    : parseRequiredString(raw.name, 'name', SCENARIO_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const description = parseOptionalNullableString(raw.description, 'description', SCENARIO_DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;
  const triggerType = parseEnumValue(raw.triggerType, 'triggerType', VALID_TRIGGER_TYPES, false);
  if (!triggerType.ok) return triggerType;
  const triggerTagId = parseOptionalNullableString(raw.triggerTagId, 'triggerTagId', ID_MAX_LENGTH);
  if (!triggerTagId.ok) return triggerTagId;
  const isActive = parseOptionalBoolean(raw.isActive, 'isActive');
  if (!isActive.ok) return isActive;
  if (
    name.value === undefined &&
    description.value === undefined &&
    triggerType.value === undefined &&
    triggerTagId.value === undefined &&
    isActive.value === undefined
  ) {
    return { ok: false, error: 'At least one field is required' };
  }
  return {
    ok: true,
    body: {
      name: name.value,
      description: description.value,
      triggerType: triggerType.value,
      triggerTagId: triggerTagId.value,
      isActive: isActive.value,
    },
  };
}

function parseStepScheduleFields(raw: Record<string, unknown>): ValueResult<StepScheduleBody> {
  const delayMinutes = parseInteger(raw.delayMinutes, 'delayMinutes', 0, DELAY_MINUTES_MAX, false);
  if (!delayMinutes.ok) return delayMinutes;
  const offsetDays = parseInteger(raw.offsetDays, 'offsetDays', 0, OFFSET_DAYS_MAX, false);
  if (!offsetDays.ok) return offsetDays;
  const offsetMinutes = parseInteger(raw.offsetMinutes, 'offsetMinutes', 0, 1439, false);
  if (!offsetMinutes.ok) return offsetMinutes;
  const deliveryTime = parseOptionalScheduleString(raw.deliveryTime, 'deliveryTime');
  if (!deliveryTime.ok) return deliveryTime;
  return {
    ok: true,
    value: {
      delayMinutes: delayMinutes.value,
      offsetDays: offsetDays.value,
      offsetMinutes: offsetMinutes.value,
      deliveryTime: deliveryTime.value,
    },
  };
}

function parseScenarioStepCreateBody(raw: unknown): ParseResult<ScenarioStepCreateBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const stepOrder = parseInteger(raw.stepOrder, 'stepOrder', 1, STEP_ORDER_MAX, true);
  if (!stepOrder.ok) return stepOrder;
  const schedule = parseStepScheduleFields(raw);
  if (!schedule.ok) return schedule;
  const messageType = parseEnumValue(raw.messageType, 'messageType', VALID_MESSAGE_TYPES, true);
  if (!messageType.ok) return messageType;
  const messageContent = parseMessageContent(raw.messageContent, messageType.value, true);
  if (!messageContent.ok) return messageContent;
  const conditionType = parseConditionType(raw.conditionType);
  if (!conditionType.ok) return conditionType;
  const conditionValue = parseConditionValue(raw.conditionValue);
  if (!conditionValue.ok) return conditionValue;
  if (conditionType.value != null) {
    if (conditionValue.value == null) return { ok: false, error: 'conditionValue is required' };
    const condition = validateConditionValue(conditionType.value, conditionValue.value);
    if (!condition.ok) return condition;
  } else if (conditionValue.value != null) {
    return { ok: false, error: 'conditionType is required when conditionValue is set' };
  }
  const nextStepOnFalse = parseOptionalNullableInteger(raw.nextStepOnFalse, 'nextStepOnFalse', 1, STEP_ORDER_MAX);
  if (!nextStepOnFalse.ok) return nextStepOnFalse;
  const templateId = parseOptionalNullableString(raw.templateId, 'templateId', ID_MAX_LENGTH);
  if (!templateId.ok) return templateId;
  const onReachTagId = parseOptionalNullableString(raw.onReachTagId, 'onReachTagId', ID_MAX_LENGTH);
  if (!onReachTagId.ok) return onReachTagId;
  return {
    ok: true,
    body: {
      stepOrder: stepOrder.value,
      ...schedule.value,
      messageType: messageType.value,
      messageContent: messageContent.value,
      conditionType: conditionType.value,
      conditionValue: conditionValue.value,
      nextStepOnFalse: nextStepOnFalse.value,
      templateId: templateId.value,
      onReachTagId: onReachTagId.value,
    },
  };
}

function parseScenarioStepUpdateBody(raw: unknown): ParseResult<ScenarioStepUpdateBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const stepOrder = parseInteger(raw.stepOrder, 'stepOrder', 1, STEP_ORDER_MAX, false);
  if (!stepOrder.ok) return stepOrder;
  const schedule = parseStepScheduleFields(raw);
  if (!schedule.ok) return schedule;
  const messageType = parseEnumValue(raw.messageType, 'messageType', VALID_MESSAGE_TYPES, false);
  if (!messageType.ok) return messageType;
  const messageContent = parseMessageContent(raw.messageContent, messageType.value, false);
  if (!messageContent.ok) return messageContent;
  const conditionType = parseConditionType(raw.conditionType);
  if (!conditionType.ok) return conditionType;
  const conditionValue = parseConditionValue(raw.conditionValue);
  if (!conditionValue.ok) return conditionValue;
  if (conditionType.value != null && conditionValue.value != null) {
    const condition = validateConditionValue(conditionType.value, conditionValue.value);
    if (!condition.ok) return condition;
  }
  if (conditionType.value === null && conditionValue.value !== undefined && conditionValue.value !== null) {
    return { ok: false, error: 'conditionValue must be cleared with conditionType' };
  }
  const nextStepOnFalse = parseOptionalNullableInteger(raw.nextStepOnFalse, 'nextStepOnFalse', 1, STEP_ORDER_MAX);
  if (!nextStepOnFalse.ok) return nextStepOnFalse;
  const templateId = parseOptionalNullableString(raw.templateId, 'templateId', ID_MAX_LENGTH);
  if (!templateId.ok) return templateId;
  const onReachTagId = parseOptionalNullableString(raw.onReachTagId, 'onReachTagId', ID_MAX_LENGTH);
  if (!onReachTagId.ok) return onReachTagId;
  const body = {
    stepOrder: stepOrder.value,
    ...schedule.value,
    messageType: messageType.value,
    messageContent: messageContent.value,
    conditionType: conditionType.value,
    conditionValue: conditionValue.value,
    nextStepOnFalse: nextStepOnFalse.value,
    templateId: templateId.value,
    onReachTagId: onReachTagId.value,
  };
  if (Object.values(body).every((value) => value === undefined)) {
    return { ok: false, error: 'At least one field is required' };
  }
  return { ok: true, body };
}

function parseStepReorderBody(raw: unknown): ParseResult<StepReorderBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  if (!Array.isArray(raw.orders) || raw.orders.length === 0) {
    return { ok: false, error: 'orders must be a non-empty array' };
  }
  if (raw.orders.length > REORDER_MAX_ITEMS) return { ok: false, error: 'orders is too large' };
  const orders: StepReorderBody['orders'] = [];
  const stepIds = new Set<string>();
  const stepOrders = new Set<number>();
  for (const item of raw.orders) {
    if (!isRecord(item)) return { ok: false, error: 'invalid orders entry' };
    const stepId = parseRequiredString(item.stepId, 'stepId', ID_MAX_LENGTH);
    if (!stepId.ok) return { ok: false, error: 'invalid orders entry' };
    const stepOrder = parseInteger(item.stepOrder, 'stepOrder', 1, STEP_ORDER_MAX, true);
    if (!stepOrder.ok) return { ok: false, error: 'invalid orders entry' };
    if (stepIds.has(stepId.value)) return { ok: false, error: 'duplicate stepId in orders' };
    if (stepOrders.has(stepOrder.value)) return { ok: false, error: 'duplicate stepOrder in orders' };
    stepIds.add(stepId.value);
    stepOrders.add(stepOrder.value);
    orders.push({ stepId: stepId.value, stepOrder: stepOrder.value });
  }
  return { ok: true, body: { orders } };
}

/** delivery_mode に応じてスケジュールフィールドを検証する。 */
function validateStepSchedule(
  mode: DeliveryMode,
  body: StepScheduleBody,
): { ok: true } | { ok: false; error: string } {
  if (mode === 'relative') {
    if (body.offsetDays != null || body.offsetMinutes != null || body.deliveryTime != null) {
      return { ok: false, error: 'relative mode: only delayMinutes is allowed' };
    }
    if (typeof body.delayMinutes !== 'number' || body.delayMinutes < 0) {
      return { ok: false, error: 'relative mode: delayMinutes (>=0) is required' };
    }
    return { ok: true };
  }
  if (mode === 'elapsed') {
    if (body.delayMinutes != null || body.deliveryTime != null) {
      return { ok: false, error: 'elapsed mode: only offsetDays + offsetMinutes are allowed' };
    }
    if (typeof body.offsetDays !== 'number' || body.offsetDays < 0) {
      return { ok: false, error: 'elapsed mode: offsetDays (>=0) is required' };
    }
    if (typeof body.offsetMinutes !== 'number' || body.offsetMinutes < 0 || body.offsetMinutes >= 1440) {
      return { ok: false, error: 'elapsed mode: offsetMinutes (0..1439) is required' };
    }
    return { ok: true };
  }
  // absolute_time
  if (body.delayMinutes != null || body.offsetMinutes != null) {
    return { ok: false, error: 'absolute_time mode: only offsetDays + deliveryTime are allowed' };
  }
  if (typeof body.offsetDays !== 'number' || body.offsetDays < 0) {
    return { ok: false, error: 'absolute_time mode: offsetDays (>=0) is required' };
  }
  if (typeof body.deliveryTime !== 'string' || !HHMM_RE.test(body.deliveryTime)) {
    return { ok: false, error: 'absolute_time mode: deliveryTime must match HH:MM' };
  }
  return { ok: true };
}

/** Convert D1 snake_case FriendScenario row to shared camelCase shape */
function serializeFriendScenario(row: DbFriendScenario) {
  return {
    id: row.id,
    friendId: row.friend_id,
    scenarioId: row.scenario_id,
    currentStepOrder: row.current_step_order,
    status: row.status,
    startedAt: row.started_at,
    nextDeliveryAt: row.next_delivery_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/scenarios - list all
scenarios.get('/api/scenarios', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsedLineAccountId = parseOptionalVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!parsedLineAccountId.ok) return c.json({ success: false, error: parsedLineAccountId.error }, 400);
    const lineAccountId = parsedLineAccountId.value;
    let items: DbScenarioWithStepCount[];
    if (lineAccountId) {
      const result = await c.env.DB
        .prepare(
          `SELECT s.*, COUNT(ss.id) as step_count
           FROM scenarios s
           LEFT JOIN scenario_steps ss ON s.id = ss.scenario_id
           WHERE s.line_account_id IS NULL OR s.line_account_id = ?
           GROUP BY s.id
           ORDER BY s.created_at DESC`,
        )
        .bind(lineAccountId)
        .all<DbScenarioWithStepCount>();
      items = result.results;
    } else {
      items = await getScenarios(c.env.DB);
    }
    return c.json({
      success: true,
      data: items.map((row) => ({
        ...serializeScenario(row),
        stepCount: row.step_count,
      })),
    });
  } catch (err) {
    console.error('GET /api/scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/scenarios/:id - get with steps
scenarios.get('/api/scenarios/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const scenario = await getScenarioById(c.env.DB, id.value);

    if (!scenario) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeScenario(scenario),
        steps: scenario.steps.map(serializeStep),
      },
    });
  } catch (err) {
    console.error('GET /api/scenarios/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/scenarios - create
scenarios.post('/api/scenarios', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseScenarioCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    let scenario = await createScenario(c.env.DB, {
      name: body.name,
      description: body.description ?? null,
      triggerType: body.triggerType,
      triggerTagId: body.triggerTagId ?? null,
      deliveryMode: body.deliveryMode,
    });

    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE scenarios SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, scenario.id).run();
    }

    // createScenario() always sets is_active=1; override if the caller requested inactive
    if (body.isActive === false) {
      const updated = await updateScenario(c.env.DB, scenario.id, { is_active: 0 });
      if (updated) scenario = updated;
    }

    return c.json({ success: true, data: serializeScenario(scenario) }, 201);
  } catch (err) {
    console.error('POST /api/scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/scenarios/:id - update (accepts camelCase fields from clients)
scenarios.put('/api/scenarios/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseScenarioUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const updated = await updateScenario(c.env.DB, id.value, {
      name: body.name,
      description: body.description,
      trigger_type: body.triggerType,
      trigger_tag_id: body.triggerTagId,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }

    return c.json({ success: true, data: serializeScenario(updated) });
  } catch (err) {
    console.error('PUT /api/scenarios/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/scenarios/:id - delete
scenarios.delete('/api/scenarios/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteScenario(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/scenarios/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/scenarios/:id/steps - add step
scenarios.post('/api/scenarios/:id/steps', requireRole('owner', 'admin'), async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseScenarioStepCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const scenarioRow = await c.env.DB
      .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
      .bind(scenarioId.value)
      .first<{ delivery_mode: DeliveryMode }>();
    if (!scenarioRow) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }

    const v = validateStepSchedule(scenarioRow.delivery_mode, body);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);

    // templateId / onReachTagId 参照整合性チェック
    if (body.templateId != null) {
      const tpl = await c.env.DB
        .prepare(`SELECT id FROM templates WHERE id = ?`)
        .bind(body.templateId)
        .first<{ id: string }>();
      if (!tpl) return c.json({ success: false, error: 'templateId not found' }, 400);
    }
    if (body.onReachTagId != null) {
      const tag = await c.env.DB
        .prepare(`SELECT id FROM tags WHERE id = ?`)
        .bind(body.onReachTagId)
        .first<{ id: string }>();
      if (!tag) return c.json({ success: false, error: 'onReachTagId not found' }, 400);
    }

    const step = await createScenarioStep(c.env.DB, {
      scenarioId: scenarioId.value,
      stepOrder: body.stepOrder,
      delayMinutes: body.delayMinutes ?? 0,
      messageType: body.messageType,
      messageContent: body.messageContent,
      conditionType: body.conditionType ?? null,
      conditionValue: body.conditionValue ?? null,
      nextStepOnFalse: body.nextStepOnFalse ?? null,
      offsetDays: body.offsetDays ?? null,
      offsetMinutes: body.offsetMinutes ?? null,
      deliveryTime: body.deliveryTime ?? null,
      templateId: body.templateId ?? null,
      onReachTagId: body.onReachTagId ?? null,
    });

    return c.json({ success: true, data: serializeStep(step) }, 201);
  } catch (err) {
    console.error('POST /api/scenarios/:id/steps error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/scenarios/:id/steps/:stepId - update step (accepts camelCase)
scenarios.put('/api/scenarios/:id/steps/:stepId', requireRole('owner', 'admin'), async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const stepId = parseVisibleId(c.req.param('stepId'), 'stepId');
    if (!stepId.ok) return c.json({ success: false, error: stepId.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseScenarioStepUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const existingStep = await c.env.DB
      .prepare(
        `SELECT delay_minutes, offset_days, offset_minutes, delivery_time, message_type, message_content
         FROM scenario_steps WHERE id = ? AND scenario_id = ?`,
      )
      .bind(stepId.value, scenarioId.value)
      .first<{
        delay_minutes: number;
        offset_days: number | null;
        offset_minutes: number | null;
        delivery_time: string | null;
        message_type: MessageType;
        message_content: string;
      }>();
    if (!existingStep) {
      return c.json({ success: false, error: 'Step not found' }, 404);
    }

    // templateId / onReachTagId 参照整合性チェック (null は解除を意図、bypass)
    // templateId が指定された場合は内容も取得して snapshot 更新に使う。
    let templateSnapshot: { message_type: string; message_content: string } | null = null;
    if (body.templateId !== undefined && body.templateId !== null) {
      const tpl = await c.env.DB
        .prepare(`SELECT id, message_type, message_content FROM templates WHERE id = ?`)
        .bind(body.templateId)
        .first<{ id: string; message_type: string; message_content: string }>();
      if (!tpl) return c.json({ success: false, error: 'templateId not found' }, 400);
      templateSnapshot = { message_type: tpl.message_type, message_content: tpl.message_content };
    }
    if (body.onReachTagId !== undefined && body.onReachTagId !== null) {
      const tag = await c.env.DB
        .prepare(`SELECT id FROM tags WHERE id = ?`)
        .bind(body.onReachTagId)
        .first<{ id: string }>();
      if (!tag) return c.json({ success: false, error: 'onReachTagId not found' }, 400);
    }

    // スケジュールフィールドが1つでも指定されている場合は、既存値を DB から読んで
    // partial body と merge してから validateStepSchedule に渡す。
    // (1 フィールドだけ更新するケース、例: elapsed step の offsetMinutes だけ変更、
    //  absolute_time step の deliveryTime だけ変更 を許可するため)
    const scheduleTouched =
      body.delayMinutes !== undefined ||
      body.offsetDays !== undefined ||
      body.offsetMinutes !== undefined ||
      body.deliveryTime !== undefined;
    if (scheduleTouched) {
      const scenarioRow = await c.env.DB
        .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
        .bind(scenarioId.value)
        .first<{ delivery_mode: DeliveryMode }>();
      if (!scenarioRow) {
        return c.json({ success: false, error: 'Scenario not found' }, 404);
      }
      // mode mismatch (relative scenario に offsetDays を投げる等) は body の生値で検出する。
      // 一方、対応 mode のフィールドが片方だけ送られた場合 (例: absolute_time で deliveryTime のみ)
      // は既存値で穴埋めする。
      const scheduleForValidation: {
        delayMinutes?: number;
        offsetDays?: number;
        offsetMinutes?: number;
        deliveryTime?: string;
      } = {
        delayMinutes: body.delayMinutes,
        offsetDays: body.offsetDays,
        offsetMinutes: body.offsetMinutes,
        deliveryTime: body.deliveryTime,
      };
      if (scenarioRow.delivery_mode === 'relative') {
        if (scheduleForValidation.delayMinutes === undefined) {
          scheduleForValidation.delayMinutes = existingStep.delay_minutes;
        }
      } else if (scenarioRow.delivery_mode === 'elapsed') {
        if (scheduleForValidation.offsetDays === undefined && existingStep.offset_days != null) {
          scheduleForValidation.offsetDays = existingStep.offset_days;
        }
        if (scheduleForValidation.offsetMinutes === undefined && existingStep.offset_minutes != null) {
          scheduleForValidation.offsetMinutes = existingStep.offset_minutes;
        }
      } else {
        // absolute_time
        if (scheduleForValidation.offsetDays === undefined && existingStep.offset_days != null) {
          scheduleForValidation.offsetDays = existingStep.offset_days;
        }
        if (scheduleForValidation.deliveryTime === undefined && existingStep.delivery_time != null) {
          scheduleForValidation.deliveryTime = existingStep.delivery_time;
        }
      }
      const v = validateStepSchedule(scenarioRow.delivery_mode, scheduleForValidation);
      if (!v.ok) return c.json({ success: false, error: v.error }, 400);
    }

    // templateId が指定された場合は snapshot (message_type/message_content) も
    // 同時に更新する。templates テーブルから取った値を優先することで、stale な
    // body 内容 (UI の templates state が古い等) が保存されるのを防ぐ。
    // templateId が指定されていない場合は body の値をそのまま使う (直接入力モード)。
    const effectiveMessageType = templateSnapshot
      ? ((templateSnapshot.message_type === 'carousel' ? 'flex' : templateSnapshot.message_type) as MessageType)
      : body.messageType;
    const effectiveMessageContent = templateSnapshot
      ? templateSnapshot.message_content
      : body.messageContent;
    const messageTouched =
      templateSnapshot !== null ||
      body.messageType !== undefined ||
      body.messageContent !== undefined;
    if (messageTouched) {
      const finalMessageType = (effectiveMessageType ?? existingStep.message_type) as MessageType;
      const finalMessageContent = effectiveMessageContent ?? existingStep.message_content;
      const content = validateMessageContent(finalMessageType, finalMessageContent);
      if (!content.ok) return c.json({ success: false, error: content.error }, 400);
    }

    const updated = await updateScenarioStep(c.env.DB, stepId.value, {
      step_order: body.stepOrder,
      delay_minutes: body.delayMinutes,
      message_type: effectiveMessageType,
      message_content: effectiveMessageContent,
      condition_type: body.conditionType,
      condition_value: body.conditionValue,
      next_step_on_false: body.nextStepOnFalse,
      offset_days: body.offsetDays,
      offset_minutes: body.offsetMinutes,
      delivery_time: body.deliveryTime,
      template_id: body.templateId,
      on_reach_tag_id: body.onReachTagId,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Step not found' }, 404);
    }

    return c.json({ success: true, data: serializeStep(updated) });
  } catch (err) {
    console.error('PUT /api/scenarios/:id/steps/:stepId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/scenarios/:id/steps/:stepId - delete step
scenarios.delete('/api/scenarios/:id/steps/:stepId', requireRole('owner', 'admin'), async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const stepId = parseVisibleId(c.req.param('stepId'), 'stepId');
    if (!stepId.ok) return c.json({ success: false, error: stepId.error }, 400);
    const existing = await c.env.DB
      .prepare(`SELECT id FROM scenario_steps WHERE id = ? AND scenario_id = ?`)
      .bind(stepId.value, scenarioId.value)
      .first<{ id: string }>();
    if (!existing) return c.json({ success: false, error: 'Step not found' }, 404);
    await deleteScenarioStep(c.env.DB, stepId.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/scenarios/:id/steps/:stepId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/scenarios/:id/steps/reorder - bulk update step_order
scenarios.post('/api/scenarios/:id/steps/reorder', requireRole('owner', 'admin'), async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseStepReorderBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    // 既存ステップの step_order と next_step_on_false を取得して、
    // 旧 step_order → 新 step_order のマップを構築する。
    // 既存の branching (next_step_on_false) を保つには、移動する step の旧→新 step_order マップで
    // 各 step の next_step_on_false 値を書き換える必要がある。
    const existing = await c.env.DB
      .prepare(`SELECT id, step_order FROM scenario_steps WHERE scenario_id = ?`)
      .bind(scenarioId.value)
      .all<{ id: string; step_order: number }>();
    const oldOrderById = new Map(existing.results.map((r) => [r.id, r.step_order]));
    const missing = body.orders.find((o) => !oldOrderById.has(o.stepId));
    if (missing) {
      return c.json({ success: false, error: 'Step not found' }, 404);
    }
    // moved set: stepId → newOrder
    const newOrderById = new Map(body.orders.map((o) => [o.stepId, o.stepOrder]));
    // old → new step_order map (only for moved steps)
    const oldToNew = new Map<number, number>();
    for (const [stepId, newOrder] of newOrderById) {
      const oldOrder = oldOrderById.get(stepId);
      if (oldOrder !== undefined && oldOrder !== newOrder) {
        oldToNew.set(oldOrder, newOrder);
      }
    }

    // UNIQUE(scenario_id, step_order) 衝突回避: 一旦負数空間に逃がしてから最終値に再代入する2フェーズ。
    const phase1 = body.orders.map((o, i) =>
      c.env.DB
        .prepare(`UPDATE scenario_steps SET step_order = ? WHERE id = ? AND scenario_id = ?`)
        .bind(-1 - i, o.stepId, scenarioId.value),
    );
    const phase2 = body.orders.map((o) =>
      c.env.DB
        .prepare(`UPDATE scenario_steps SET step_order = ? WHERE id = ? AND scenario_id = ?`)
        .bind(o.stepOrder, o.stepId, scenarioId.value),
    );
    // phase3: branching ターゲット (next_step_on_false) も同様に2フェーズで書き換える。
    // 入れ替え (A 旧2→新4, B 旧4→新2) のケースで一発 UPDATE すると後続が前の結果を上書きするため、
    // 一旦負数 sentinel に逃がしてから新値に書く。
    const oldToNewArr = Array.from(oldToNew.entries());
    const phase3a = oldToNewArr.map(([oldOrder], i) =>
      c.env.DB
        .prepare(
          `UPDATE scenario_steps SET next_step_on_false = ?
           WHERE scenario_id = ? AND next_step_on_false = ?`,
        )
        .bind(-1000 - i, scenarioId.value, oldOrder),
    );
    const phase3b = oldToNewArr.map(([, newOrder], i) =>
      c.env.DB
        .prepare(
          `UPDATE scenario_steps SET next_step_on_false = ?
           WHERE scenario_id = ? AND next_step_on_false = ?`,
        )
        .bind(newOrder, scenarioId.value, -1000 - i),
    );
    await c.env.DB.batch([...phase1, ...phase2, ...phase3a, ...phase3b]);

    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/scenarios/:id/steps/reorder error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/scenarios/:id/preview - timeline preview (deterministic, no jitter)
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

scenarios.get('/api/scenarios/:id/preview', requireRole('owner', 'admin'), async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const startParam = parseOptionalDateCursor(c.req.query('startAt'), 'startAt');
    if (!startParam.ok) return c.json({ success: false, error: startParam.error }, 400);
    const scenarioRow = await c.env.DB
      .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
      .bind(scenarioId.value)
      .first<{ delivery_mode: DeliveryMode }>();
    if (!scenarioRow) return c.json({ success: false, error: 'Scenario not found' }, 404);

    const stepsResult = await c.env.DB
      .prepare(
        `SELECT id, step_order, delay_minutes, offset_days, offset_minutes, delivery_time,
                template_id, message_type, message_content
         FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
      )
      .bind(scenarioId.value)
      .all<{
        id: string;
        step_order: number;
        delay_minutes: number;
        offset_days: number | null;
        offset_minutes: number | null;
        delivery_time: string | null;
        template_id: string | null;
        message_type: string;
        message_content: string;
      }>();
    const steps = stepsResult.results;

    // 配信時と同じ resolveStepContent を呼んで、template_id があれば templates から
    // 最新内容を取って preview に返す。これで配信と preview の表示が一致する。
    const resolvedSteps = await Promise.all(
      steps.map(async (step) => {
        const resolved = await resolveStepContent(c.env.DB, step);
        return { step, resolved };
      }),
    );

    // computeNextDeliveryAt は「JST clock-time を UTC として表現する Date」前提。
    // クエリの startParam は "+09:00" 付き ISO で本物の UTC instant として parse されるため、
    // +9h ずらして JST clock-time 表現に揃える。default の now も同様にずらして表現する。
    const startAt = startParam.value
      ? new Date(new Date(startParam.value).getTime() + 9 * 60 * 60_000)
      : new Date(Date.now() + 9 * 60 * 60_000);

    // Day N はカレンダー日数差で算出。経過 24h 単位だと、enrolledAt 14:32 →
    // 翌日 09:00 (18.5h 後) が Day 0 と表示されてしまう (本来 Day 1)。
    // startAt と at は両方 JST clock-time として表現された Date なので、
    // 日付部分の差を計算すれば正しい Day N が出る。
    const startEpochDay = Math.floor(
      Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()) / 86_400_000,
    );
    let prev = startAt;
    const timeline = resolvedSteps.map(({ step, resolved }) => {
      const at = computeNextDeliveryAt(
        { delivery_mode: scenarioRow.delivery_mode },
        step,
        { enrolledAt: startAt, previousDeliveredAt: prev, now: startAt },
      );
      prev = at;
      const atEpochDay = Math.floor(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / 86_400_000,
      );
      const day = atEpochDay - startEpochDay;
      const hh = String(at.getHours()).padStart(2, '0');
      const mm = String(at.getMinutes()).padStart(2, '0');
      const wd = WEEKDAY_JA[at.getDay()];
      return {
        stepOrder: step.step_order,
        deliveryAt: at.toISOString().slice(0, -1) + '+09:00',
        deliveryAtLabel: `Day ${day} ${hh}:${mm} (${wd})`,
        messageType: resolved.messageType,
        messageContent: resolved.messageContent,
      };
    });

    return c.json({
      success: true,
      data: {
        startAt: startAt.toISOString().slice(0, -1) + '+09:00',
        steps: timeline,
      },
    });
  } catch (err) {
    console.error('GET /api/scenarios/:id/preview error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/scenarios/:id/stats - reach rate dashboard
scenarios.get('/api/scenarios/:id/stats', requireRole('owner', 'admin'), async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const scenario = await c.env.DB
      .prepare(`SELECT id FROM scenarios WHERE id = ?`)
      .bind(scenarioId.value)
      .first<{ id: string }>();
    if (!scenario) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }
    const stats = await computeScenarioStats(c.env.DB, scenarioId.value);
    return c.json({ success: true, data: stats });
  } catch (err) {
    console.error('GET /api/scenarios/:id/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/scenarios/:id/enroll/:friendId - manually enroll friend
scenarios.post('/api/scenarios/:id/enroll/:friendId', async (c) => {
  try {
    const scenarioId = parseVisibleId(c.req.param('id'), 'scenarioId');
    if (!scenarioId.ok) return c.json({ success: false, error: scenarioId.error }, 400);
    const friendId = parseVisibleId(c.req.param('friendId'), 'friendId');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const db = c.env.DB;

    const scenario = await getScenarioById(db, scenarioId.value);
    if (!scenario) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }

    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;

    const friend = await getFriendById(db, friendId.value);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const enrollment = await enrollFriendInScenario(db, friendId.value, scenarioId.value);
    if (!enrollment) {
      return c.json({ success: false, error: 'Already enrolled in this scenario' }, 409);
    }
    return c.json({ success: true, data: serializeFriendScenario(enrollment) }, 201);
  } catch (err) {
    console.error('POST /api/scenarios/:id/enroll/:friendId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { scenarios };
