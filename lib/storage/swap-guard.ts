// MiroFish Autonomous Fix for paraloom-core #930: concurrent PRIVATE_SWAP clobber
// Fixes https://github.com/paraloom-labs/paraloom-core/issues/930

export interface PendingSwapState {
  swapId: string;
  origin: string;
  params: any;
  createdAt: number;
}

export class ConcurrentSwapGuard {
  private static inFlightLock: boolean = false;
  private static activeSwapJobId: string | null = null;

  public static acquireSwapLock(jobId: string): boolean {
    if (this.inFlightLock) {
      return false; // Prevent race conditions
    }
    this.inFlightLock = true;
    this.activeSwapJobId = jobId;
    return true;
  }

  public static releaseSwapLock(jobId: string): void {
    if (this.activeSwapJobId === jobId) {
      this.inFlightLock = false;
      this.activeSwapJobId = null;
    }
  }

  public static async persistPendingSwap(storage: any, state: PendingSwapState): Promise<void> {
    if (storage && storage.session) {
      await storage.session.set({ pendingSwapState: state });
    }
  }
}
