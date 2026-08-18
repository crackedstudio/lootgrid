import { useGameState } from './hooks/useGameState';
import HomeScreen from './components/HomeScreen';
import OnboardingScreen from './components/OnboardingScreen';
import ZoneScreen from './components/ZoneScreen';
import GridScreen from './components/GridScreen';
import HuntPreview from './components/HuntPreview';
import HuntTranscript from './components/HuntTranscript';
import Minigame from './components/Minigame';
import WinScreen from './components/WinScreen';
import BoardScreen from './components/BoardScreen';
import AgentScreen from './components/AgentScreen';
import HuntsScreen from './components/HuntsScreen';
import MarketScreen from './components/MarketScreen';
import YouScreen from './components/YouScreen';
import NavBar from './components/NavBar';
import ConnectionGate from './components/ConnectionGate';

export default function App() {
  const game = useGameState();
  const { state } = game;

  const showZones = state.view === 'map' && !state.mapZone;
  const showGrid = state.view === 'map' && !!state.mapZone;
  const showNavBar = ['map', 'market', 'agent', 'hunts', 'board', 'you'].includes(state.view);

  /*
    ─────────────────────────── the frame ───────────────────────────

    This used to be a hard 390x844 with a 4px border and a 16px offset shadow.

    None of that was a design decision. `390x844` is the Claude Design canvas's
    `$preview` viewport — the size of the little phone mock in the design tool —
    and the border and shadow are the frame drawn *around* that mock. The
    prototype styled its root to match so it would look like a phone on a
    desktop screen. We copied the screenshot border and shipped it as a spec.

    On a 360x640 Android — squarely inside the audience this game is built for —
    the bottom of every screen, including the nav bar, sat off-canvas.

    So: fill the viewport, in `dvh` rather than `vh` so the Android URL bar
    collapsing does not clip the nav, and keep the frame only as a desktop
    affordance where there is room for it and nothing to lose by it. `lg-frame`
    is in index.css because a media query cannot be written inline.
  */
  return (
    <div
      className="lg-root lg-frame"
      style={{
        position: 'relative',
        background: 'var(--surface)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {state.view === 'home' && (
        <HomeScreen
          state={state}
          onEnter={() => game.setView('onboarding')}
          onSkipIntro={() => game.setView('map')}
        />
      )}

      {state.view === 'onboarding' && (
        <OnboardingScreen state={state} onNext={game.nextOnb} onSkip={game.skipOnb} />
      )}

      {showZones && (
        <ZoneScreen
          state={state}
          onGoHome={() => game.setView('home')}
          onEnterZone={game.enterZone}
        />
      )}

      {showGrid && (
        <GridScreen state={state} onBackZones={game.backZones} onTile={game.onTile} onToggleSurvey={game.toggleSurveyMode} onDismissStuck={game.dismissStuck} onBuy={game.buy} onSpendRefill={game.spendRefill} onAckTutorial={game.ackTutorial} />
      )}

      {state.view === 'market' && <MarketScreen state={state} />}

      {state.view === 'agent' && <AgentScreen />}

      {state.view === 'hunts' && (
        <HuntsScreen state={state} setField={game.setField} />
      )}
      {state.view === 'board' && <BoardScreen state={state} />}
      {state.view === 'you' && <YouScreen state={state} onNav={game.setView} />}

      {/* ---- overlays ---- */}
      {state.huntPreview && (
        <HuntPreview
          hunt={state.huntPreview}
          onConfirm={game.confirmHunt}
          onPay={game.acceptQuote}
          onClose={game.closeHunt}
        />
      )}

      {state.attempt && state.outcome !== 'won' && (
        <Minigame
          state={state}
          onMgTap={game.onMgTap}
          onMemPad={game.onMemPad}
          onMathPick={game.onMathPick}
          onCrackLock={game.onCrackLock}
          onSeqTap={game.onSeqTap}
          onExit={game.exitMinigame}
        />
      )}

      {state.winData && (
        <WinScreen
          state={state}
          onShare={game.doShare}
          onBackToMap={game.backToMap}
          onShowTranscript={() => game.setField('transcriptFor', state.winData.huntId)}
        />
      )}

      {state.transcriptFor && (
        <HuntTranscript
          huntId={state.transcriptFor}
          onClose={() => game.setField('transcriptFor', null)}
        />
      )}

      {showNavBar && <NavBar view={state.view} onNav={game.setView} />}

      {/* Sits above everything: if the referee is gone there is nothing to play. */}
      <ConnectionGate fatal={state.fatal} status={state.status} />
    </div>
  );
}
