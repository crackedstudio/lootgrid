import Mascot from './Mascot';
import { ONB_CARDS } from '../data/gameData';

export default function OnboardingScreen({ state, onNext, onSkip }) {
  const { onbStep } = state;
  const onb = ONB_CARDS[onbStep] || ONB_CARDS[0];

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 60, background: 'var(--deep)',
      borderTop: `10px solid ${onb.bg}`, display: 'flex', flexDirection: 'column',
      padding: '30px 26px 26px', animation: 'lg-pop .3s ease-out',
    }}>
      {/* icon box */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, justifyContent: 'center', gap: 0 }}>
        <div style={{
          width: 84, height: 84, background: onb.bg, display: 'flex', alignItems: 'center',
          justifyContent: 'center', marginBottom: 24, border: '4px solid #0C0C10',
          boxShadow: '6px 6px 0 #0C0C10',
          animation: ['lg-bob 1.6s ease-in-out infinite', 'lg-dig .5s ease-in-out infinite', 'lg-cheer 1s ease-in-out infinite'][onbStep] || 'lg-bob 1.6s ease-in-out infinite',
        }}>
          <Mascot color="#FFD51F" mole size={58} />
        </div>

        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.18em', color: onb.bg, marginBottom: 12 }}>
          {onb.kick}
        </div>
        <div style={{
          fontFamily: "'Archivo Black', sans-serif", fontSize: 26, lineHeight: 1.05,
          color: 'var(--cream)', textAlign: 'center', marginBottom: 16,
        }}>
          {onb.title}
        </div>
        <div style={{
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, lineHeight: 1.55,
          color: 'var(--cream)', opacity: .72, textAlign: 'center', maxWidth: 280,
        }}>
          {onb.body}
        </div>
      </div>

      {/* dots */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 24 }}>
        {ONB_CARDS.map((_, i) => (
          <div key={i} style={{
            width: i === onbStep ? 26 : 12, height: 12,
            border: '3px solid var(--cream)',
            background: i === onbStep ? onb.bg : 'transparent',
            transition: 'all .2s',
          }} />
        ))}
      </div>

      {/* next button */}
      <div onClick={onNext} style={{
        border: '4px solid #0C0C10', background: onb.bg,
        boxShadow: '5px 5px 0 #0C0C10', padding: '14px 24px',
        fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10', cursor: 'pointer',
        textAlign: 'center',
      }}>
        {onbStep < ONB_CARDS.length - 1 ? 'NEXT' : 'START HUNTING'}
      </div>

      <div onClick={onSkip} style={{
        fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
        letterSpacing: '.08em', color: 'var(--cream)', opacity: .55, cursor: 'pointer',
        textAlign: 'center', marginTop: 14,
      }}>
        skip intro →
      </div>
    </div>
  );
}
