/** Carries exactly what MfaChallenge.tsx (web) puts in router state — see
 *  Login.tsx's nav("/mfa-challenge", { state }) — as navigation params
 *  instead, since React Navigation has no in-memory-only equivalent of
 *  react-router's location.state that survives a screen transition. */
export type AuthStackParamList = {
  Login: undefined;
  MfaChallenge: {
    pendingToken: string;
    methods: ('totp' | 'webauthn')[];
    enrollmentRequired: boolean;
  };
};
