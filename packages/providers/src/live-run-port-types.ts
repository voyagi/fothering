// The live-run command's two ports, kept apart from port-types.ts so the deployed handlers' port
// surface stays exactly as audited: nothing here can reach a pause, a reopen or an account setting.

export interface LiveRunSendRequest {
  from: string;
  to: string;
  subject: string;
  text: string;
  configurationSetName: string;
  tags: readonly { name: string; value: string }[];
}

export interface LiveRunSendResult {
  messageId: string;
  requestId: string;
}

/** A field SES left out of its GetAccount answer reads as the string absent, never as a guessed default. */
export interface LiveRunAccount {
  vdmEnabled: string;
  productionAccessEnabled: boolean | 'absent';
  maxSendRate: number | 'absent';
  requestId: string;
}

export interface LiveRunSesPort {
  getAccount(): Promise<LiveRunAccount>;
  sendEmail(request: LiveRunSendRequest): Promise<LiveRunSendResult>;
}

/** No user id: STS returns one, and it is never written anywhere. */
export interface CallerIdentity {
  arn: string;
  account: string;
}

export interface CallerIdentityPort {
  getCallerIdentity(): Promise<CallerIdentity>;
}

/** One port per named AWS profile, so each lane signs as its own caller. */
export interface LiveRunPortFactory {
  ses(profile: string): LiveRunSesPort;
  callerIdentity(profile: string): CallerIdentityPort;
}
