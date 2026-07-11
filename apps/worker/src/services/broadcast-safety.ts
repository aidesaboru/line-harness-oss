const TRUTHY_SQL_VALUES = "'1', 'true', 'yes', 'on'";

const BROADCAST_EXCLUDED_METADATA_KEYS = [
  'broadcastExcluded',
  'broadcast_excluded',
  'doNotBroadcast',
  'do_not_broadcast',
  'noBroadcast',
  'no_broadcast',
  'sendPaused',
  'send_paused',
  'deliveryStopped',
  'delivery_stopped',
  'stopped',
  'isStopped',
];

function metadataJsonSql(friendAlias: string): string {
  return `CASE
    WHEN json_valid(COALESCE(${friendAlias}.metadata, '{}')) THEN COALESCE(${friendAlias}.metadata, '{}')
    ELSE '{}'
  END`;
}

function metadataNotTruthySql(friendAlias: string, key: string): string {
  return `LOWER(COALESCE(CAST(json_extract(${metadataJsonSql(friendAlias)}, '$.${key}') AS TEXT), '')) NOT IN (${TRUTHY_SQL_VALUES})`;
}

export function broadcastSafetyWhere(friendAlias = 'f'): string {
  const metadataClauses = BROADCAST_EXCLUDED_METADATA_KEYS
    .map((key) => metadataNotTruthySql(friendAlias, key))
    .join('\n    AND ');

  return `COALESCE(${friendAlias}.is_following, 0) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM support_cases sc_broadcast_scope
      WHERE sc_broadcast_scope.friend_id = ${friendAlias}.id
        AND sc_broadcast_scope.status != 'resolved'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM chats ch_broadcast_scope
      WHERE ch_broadcast_scope.friend_id = ${friendAlias}.id
        AND ch_broadcast_scope.status IN ('unread', 'in_progress')
    )
    AND ${metadataClauses}`;
}

export function appendBroadcastSafetyFilter(sql: string): string {
  return sql.replace(/\bWHERE\b/i, `WHERE ${broadcastSafetyWhere('f')} AND`);
}
