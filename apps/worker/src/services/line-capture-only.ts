type LineCaptureOnlyEnv = {
  LINE_CAPTURE_ONLY?: string;
  LINE_MANUAL_SEND_ENABLED?: string;
};

export function isLineCaptureOnly(env: LineCaptureOnlyEnv): boolean {
  const value = env.LINE_CAPTURE_ONLY?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function isLineManualSendEnabled(env: LineCaptureOnlyEnv): boolean {
  const value = env.LINE_MANUAL_SEND_ENABLED?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function canUseManualLineSend(env: LineCaptureOnlyEnv): boolean {
  return !isLineCaptureOnly(env) || isLineManualSendEnabled(env);
}
