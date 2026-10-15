// MiroFish Autonomous Fix for paraloom-core #929: multi-account session desync
// Fixes https://github.com/paraloom-labs/paraloom-core/issues/929

export interface SessionSyncConfig {
  activeAccountIndex: number;
  activeAccountAddress: string;
  onboardingCompleted: boolean;
}

export function syncSessionAccount(session: any, activeAccount: { index: number; address: string }): any {
  if (!session) return session;
  return {
    ...session,
    wallet: activeAccount.address,
    activeAccountIndex: activeAccount.index,
    lastSyncedAt: Date.now()
  };
}

export function guardOnboardingSessionPersistence(sessionState: any): boolean {
  if (!sessionState || !sessionState.wallet) return false;
  return true;
}
