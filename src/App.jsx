import { useGameState } from './hooks/useGameState';
import HomeScreen from './components/HomeScreen';
import OnboardingScreen from './components/OnboardingScreen';
import ZoneScreen from './components/ZoneScreen';
import GridScreen from './components/GridScreen';
import HuntPreview from './components/HuntPreview';
import Minigame from './components/Minigame';
import WinScreen from './components/WinScreen';
import BoardScreen from './components/BoardScreen';
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
  const showNavBar = ['map', 'market', 'hunts', 'board', 'you'].includes(state.view);

  return (
    <div
      className="lg-root"
      style={{
        position: 'relative',
        width: 390,
        height: 844,
        background: 'var(--surface)',
        border: '4px solid #0C0C10',
        boxShadow: '16px 16px 0 #0C0C10',
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
        <GridScreen state={state} onBackZones={game.backZones} onTile={game.onTile} />
      )}

      {state.view === 'market' && <MarketScreen state={state} />}

      {state.view === 'hunts' && (
        <HuntsScreen state={state} setField={game.setField} />
      )}
      {state.view === 'board' && (
        <BoardScreen
          state={state}
          onTabDaily={() => game.setField('boardTab', 'daily')}
          onTabAll={() => game.setField('boardTab', 'all')}
        />
      )}
      {state.view === 'you' && <YouScreen state={state} />}

      {/* ---- overlays ---- */}
      {state.huntPreview && (
        <HuntPreview
          hunt={state.huntPreview}
          onConfirm={game.confirmHunt}
          onClose={game.closeHunt}
        />
      )}

      {state.attempt && state.outcome !== 'won' && (
        <Minigame
          state={state}
          onMgTap={game.onMgTap}
          onMemPad={game.onMemPad}
          onMathPick={game.onMathPick}
          onSeqTap={game.onSeqTap}
          onExit={game.exitMinigame}
        />
      )}

      {state.winData && (
        <WinScreen state={state} onShare={game.doShare} onBackToMap={game.backToMap} />
      )}

      {showNavBar && <NavBar view={state.view} onNav={game.setView} />}

      {/* Sits above everything: if the referee is gone there is nothing to play. */}
      <ConnectionGate fatal={state.fatal} status={state.status} />
    </div>
  );
}
