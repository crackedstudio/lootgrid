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
import YouScreen from './components/YouScreen';
import NavBar from './components/NavBar';

const THEME_CLASS = { plum: 'lg-plum', rust: 'lg-rust' };

export default function App() {
  const game = useGameState('terracotta', 9);
  const { state, gridCells } = game;

  const themeClass = THEME_CLASS[state.surface] || '';
  const showZones = state.view === 'map' && !state.mapZone;
  const showGrid  = state.view === 'map' && !!state.mapZone;

  function handleNav(id) {
    if (id === 'map') {
      game.setView('map');
    } else if (id === 'hunts') {
      game.setView('hunts');
    } else if (id === 'board') {
      game.setView('board');
    } else if (id === 'you') {
      game.setView('you');
    }
  }

  const showNavBar = ['map', 'hunts', 'board', 'you'].includes(state.view);

  return (
    <div
      className={`lg-root ${themeClass}`}
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
      {/* ---- home ---- */}
      {state.view === 'home' && (
        <HomeScreen
          state={state}
          onEnter={() => game.setView('onboarding')}
          onSkipIntro={() => game.setView('map')}
        />
      )}

      {/* ---- onboarding ---- */}
      {state.view === 'onboarding' && (
        <OnboardingScreen
          state={state}
          onNext={game.nextOnb}
          onSkip={game.skipOnb}
        />
      )}

      {/* ---- map: zone picker ---- */}
      {showZones && (
        <ZoneScreen
          state={state}
          onGoHome={() => game.setView('home')}
          onEnterZone={game.enterZone}
        />
      )}

      {/* ---- map: grid ---- */}
      {showGrid && (
        <GridScreen
          state={state}
          gridCells={gridCells}
          onGoHome={() => game.setView('home')}
          onBackZones={game.backZones}
          onTile={game.onTile}
        />
      )}

      {/* ---- other tabs ---- */}
      {state.view === 'hunts' && (
        <HuntsScreen
          state={state}
          setField={game.setField}
          onDeposit={game.depositEscrow}
          onPublish={game.newHunt}
        />
      )}
      {state.view === 'board' && (
        <BoardScreen
          state={state}
          onTabDaily={() => game.setField('boardTab', 'daily')}
          onTabAll={() => game.setField('boardTab', 'all')}
        />
      )}
      {state.view === 'you' && <YouScreen />}

      {/* ---- overlays (render above everything) ---- */}
      {state.huntPreview && (
        <HuntPreview
          cell={state.huntPreview}
          onConfirm={game.confirmHunt}
          onClose={game.closeHunt}
        />
      )}

      {state.showMinigame && (
        <Minigame
          state={state}
          onMgTap={game.onMgTap}
          onMemPad={game.onMemPad}
          onMathPick={game.onMathPick}
          onSeqTap={game.onSeqTap}
        />
      )}

      {state.showWin && (
        <WinScreen
          state={state}
          onShare={game.doShare}
          onBackToMap={game.backToMap}
        />
      )}

      {/* ---- nav bar ---- */}
      {showNavBar && (
        <NavBar view={state.view} onNav={handleNav} />
      )}

      {/* ---- live ticker (map views) ---- */}
      {(showZones || showGrid) && (
        <div style={{
          flexShrink: 0, borderTop: '3px solid #0C0C10', background: '#0C0C10',
          overflow: 'hidden', height: 30, display: 'flex', alignItems: 'center',
        }}>
          <div style={{
            display: 'flex', gap: 0,
            animation: 'lg-marquee 18s linear infinite',
            whiteSpace: 'nowrap',
          }}>
            {[0,1].map(rep => (
              <span key={rep} style={{ display: 'flex', gap: 0 }}>
                {['@maya cracked $12.00', '@deji solved a puzzle', '@ama found a clue', '@kofi opened 3 tiles', '@zara is hunting DEEP HOLLOW'].map((t, i) => (
                  <span key={i} style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: '#FFD51F', padding: '0 24px', letterSpacing: '.08em' }}>
                    {t} ·
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
