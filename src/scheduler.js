const SIX_HOURS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function createScheduler({ syncService, getCurrentSeason }) {
  let timers = [];

  return {
    start() {
      if (timers.length) return;
      timers = [
        setInterval(() => {
          const { year, season } = getCurrentSeason();
          syncService.refreshCountdowns(year, season).catch(console.error);
        }, SIX_HOURS),
        setInterval(() => {
          const { year, season } = getCurrentSeason();
          syncService.syncSeason(year, season).catch(console.error);
        }, TWENTY_FOUR_HOURS)
      ];
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
    },
    isRunning: () => timers.length > 0
  };
}

module.exports = { createScheduler };
