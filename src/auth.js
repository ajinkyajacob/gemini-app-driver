export const SIGN_IN_HINT =
  'Sign in to Gemini in the app window (the driver cannot enter your password), then run "gemini-app-driver login" or retry.';

export class AuthRequiredError extends Error {
  constructor(message, { state = 'sign-in-required', url = null } = {}) {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'SIGN_IN_REQUIRED';
    this.state = state;
    this.url = url;
  }
}
