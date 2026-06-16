type LineCaptureOnlyEnv = {
  LINE_CAPTURE_ONLY?: string;
};

export function isLineCaptureOnly(env: LineCaptureOnlyEnv): boolean {
  const value = env.LINE_CAPTURE_ONLY?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
