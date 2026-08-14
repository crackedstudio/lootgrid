import { useCallback, useEffect, useState } from 'react';
import {
  acceptBid,
  bidOn,
  cancelListing,
  describeListing,
  fetchBids,
  fetchTrust,
  fetchListings,
  fetchMyListings,
  fetchTrades,
  formatCents,
  fundQuote,
  listHint,
  overpriced,
  quoteBuy,
  submitRelease,
  syncTrade,
  tradeStatusLabel,
  trustLabel,
} from '../api/market';
import { describe as describeHint, reliabilityPct, tierLabel } from '../api/hints';

/**
 * The hint market.
 *
 * ─────────────────────────── the one design rule ───────────────────────────
 *
 * **A buyer never sees a payload before they have paid for it**, and this screen
 * is the last place that could accidentally leak one. Listings carry a tier and
 * an advertised reliability and nothing else; the hint arrives once, attached to
 * a delivered trade.
 *
 * The second rule follows from the first: reliability is shown *every* time a
 * price is. A tier-3 hint rules out most of the grid and is right about half the
 * time, and a player about to spend money on one deserves that stated plainly
 * rather than implied by a label.
 */

const CARD = { border: '3px solid #0C0C10', background: 'var(--card)', padding: 14, marginBottom: 12 };
const MONO = "'Space Mono', monospace";
const BLACK = "'Archivo Black', sans-serif";

const TIER_COLOR = { 1: '#29E6E6', 2: '#FFD51F', 3: '#FF7A1A' };

function Label({ children, dark }) {
  return (
    <div style={{
      fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '.16em',
      color: dark ? '#0C0C10' : 'var(--cream)', opacity: .55,
    }}>{children}</div>
  );
}

function Button({ children, onClick, color = '#FFD51F', disabled }) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        border: `3px solid ${disabled ? 'rgba(12,12,16,.3)' : '#0C0C10'}`,
        background: disabled ? 'transparent' : color,
        padding: '9px 12px', textAlign: 'center',
        fontFamily: BLACK, fontSize: 12, color: disabled ? 'rgba(12,12,16,.35)' : '#0C0C10',
        cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none', flex: 1,
      }}
    >{children}</div>
  );
}

function Tabs({ tab, onTab }) {
  return (
    <div style={{ display: 'flex', borderBottom: '3px solid #0C0C10', flexShrink: 0 }}>
      {[['browse', 'BROWSE'], ['selling', 'SELLING'], ['trades', 'TRADES']].map(([id, label]) => (
        <div
          key={id}
          onClick={() => onTab(id)}
          style={{
            flex: 1, padding: '11px 0', textAlign: 'center', cursor: 'pointer',
            fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '.12em',
            background: tab === id ? '#0C0C10' : 'var(--card)',
            color: tab === id ? '#FFD51F' : '#0C0C10',
            borderRight: id === 'trades' ? 'none' : '2px solid #0C0C10',
          }}
        >{label}</div>
      ))}
    </div>
  );
}

/** The claim, priced. Never the hint. */
const TRUST_TONE = { good: '#2CE66A', neutral: '#0C0C10', warn: '#FF7A1A', bad: '#FF3D3D' };

function ListingCard({ listing, onBuy, onBid, busy, trust }) {
  const pct = Math.round((listing.reliabilityBps ?? 0) / 100);
  const badge = trustLabel(trust);

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{
          fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '.14em',
          color: '#0C0C10', background: TIER_COLOR[listing.tier] ?? '#FFD51F',
          padding: '3px 7px', border: '2px solid #0C0C10',
        }}>
          {tierLabel(listing.tier).toUpperCase()} · {pct}%
        </div>
        <div style={{ fontFamily: BLACK, fontSize: 22, color: '#0C0C10' }}>
          {formatCents(listing.askCents)}
        </div>
      </div>

      <div style={{
        fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, lineHeight: 1.45,
        color: '#0C0C10', marginTop: 8,
      }}>
        {describeListing(listing)}. About the hunt in <strong>{listing.zoneId}</strong>.
      </div>

      {/* Both of these are warnings, and both are honest ones. A hint sold four
          times is a hint four rivals already have; an ask above the model is a
          seller betting you will not check. */}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Who you would be paying. Shown next to the warnings, not buried:
            the seller is as much of the trade as the hint is. */}
        <div style={{
          fontFamily: MONO, fontSize: 9, fontWeight: 700,
          color: TRUST_TONE[badge.tone], opacity: badge.tone === 'neutral' ? .55 : 1,
        }}>
          SELLER {badge.text}
        </div>
        {listing.sold > 0 && (
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: '#FF3D3D' }}>
            {listing.sold} ALREADY SOLD
          </div>
        )}
        {overpriced(listing) && (
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: '#0C0C10', opacity: .55 }}>
            MODEL SAYS {formatCents(listing.suggestedCents)}
          </div>
        )}
        {!listing.rational && (
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: '#FF3D3D' }}>
            WORTH LESS THAN THE PRIZE SHARE
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button onClick={() => onBuy(listing)} disabled={busy}>BUY</Button>
        <Button color="#29E6E6" onClick={() => onBid(listing)} disabled={busy}>BID</Button>
      </div>
    </div>
  );
}

function TradeCard({ trade, onSync, onPay, onRelease }) {
  const delivered = trade.delivered;

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Label dark>{tradeStatusLabel(trade.status).toUpperCase()}</Label>
        <div style={{ fontFamily: BLACK, fontSize: 16, color: '#0C0C10' }}>
          {formatCents(trade.priceCents)}
        </div>
      </div>

      {delivered && (
        <div style={{
          border: '3px solid #0C0C10', background: '#FFD51F', padding: '10px 12px', marginTop: 10,
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, color: '#0C0C10',
        }}>
          {describeHint(delivered.hint.payload)}
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, marginTop: 6, opacity: .7 }}>
            {tierLabel(delivered.hint.tier).toUpperCase()} · RIGHT {reliabilityPct(delivered.hint)}% OF THE TIME
          </div>
        </div>
      )}

      {trade.mismatch && (
        <div style={{
          border: '3px solid #FF3D3D', padding: '10px 12px', marginTop: 10,
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, color: '#0C0C10',
        }}>
          The chain does not match this trade ({trade.mismatch}). Nothing has been released —
          your money is refundable once the trade expires.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {trade.status === 'quoted' && <Button onClick={() => onPay(trade)}>PAY</Button>}
        {trade.status === 'funded' && trade.release && (
          <Button color="#B7FF3B" onClick={() => onRelease(trade)}>RELEASE</Button>
        )}
        {trade.status !== 'delivered' && (
          <Button color="#29E6E6" onClick={() => onSync(trade)}>REFRESH</Button>
        )}
      </div>
    </div>
  );
}

export default function MarketScreen({ state }) {
  const { hints = [], mapZone } = state;

  const [tab, setTab] = useState('browse');
  const [listings, setListings] = useState([]);
  const [mine, setMine] = useState([]);
  const [trades, setTrades] = useState([]);
  const [bids, setBids] = useState({});
  const [trust, setTrust] = useState({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(
    () =>
      Promise.all([
        fetchListings(mapZone),
        fetchMyListings().catch(() => []),
        fetchTrades().catch(() => []),
      ]),
    [mapZone],
  );

  const apply = useCallback(([open, own, mytrades]) => {
    setListings(open);
    setMine(own);
    setTrades(mytrades);

    // One lookup per distinct seller, not per listing.
    const sellers = [...new Set(open.map(l => l.sellerId))];
    Promise.all(sellers.map(id => fetchTrust(id).then(r => [id, r]))).then(pairs =>
      setTrust(Object.fromEntries(pairs)),
    );
  }, []);

  const onLoadError = useCallback(err => {
    // A market that is switched off is an ordinary state, not a failure.
    setNote(err?.code === 'market_disabled' ? 'The market is not open yet.' : err?.code ?? null);
  }, []);

  const refresh = useCallback(
    () => load().then(apply).catch(onLoadError),
    [load, apply, onLoadError],
  );

  useEffect(() => {
    // Guarded against arriving after the screen has gone: switching tabs mid
    // fetch is the normal case, not the exception.
    let alive = true;
    load()
      .then(data => alive && apply(data))
      .catch(err => alive && onLoadError(err));
    return () => {
      alive = false;
    };
  }, [load, apply, onLoadError]);

  // A trade waiting on a transaction resolves in its own time, so poll while
  // the player is looking at it. Nothing here is on a gameplay path.
  useEffect(() => {
    if (tab !== 'trades') return undefined;
    const pending = trades.some(t => t.status === 'quoted' || t.status === 'funded');
    if (!pending) return undefined;

    const timer = setInterval(() => {
      Promise.all(
        trades
          .filter(t => t.status === 'quoted' || t.status === 'funded')
          .map(t => syncTrade(t.id).catch(() => null)),
      ).then(updated => {
        const byId = new Map(updated.filter(Boolean).map(t => [t.id, t]));
        setTrades(prev => prev.map(t => byId.get(t.id) ?? t));
      });
    }, 5_000);
    return () => clearInterval(timer);
  }, [tab, trades]);

  const guard = async (fn, ok) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (ok) setNote(ok);
    } catch (err) {
      // Unlike a published record, a failed payment must be visible: a player
      // who thinks they bought a hint and did not is worse off than one told so.
      setNote(err?.code || err?.message || 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  const onBuy = listing =>
    guard(async () => {
      const quote = await quoteBuy(listing.id);
      await fundQuote(quote);
      setTab('trades');
      await refresh();
    }, 'Payment sent. Release it once the chain confirms.');

  const onBid = listing =>
    guard(async () => {
      const raw = window.prompt(`Offer for this hint, in cents (ask is ${listing.askCents}c)`);
      const cents = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(cents)) return;
      await bidOn(listing.id, cents);
    }, 'Bid placed.');

  const onSync = trade =>
    guard(async () => {
      const updated = await syncTrade(trade.id);
      setTrades(prev => prev.map(t => (t.id === updated.id ? updated : t)));
    });

  const onPay = trade =>
    guard(async () => {
      // The quote is regenerated rather than cached: a vouch is a bearer token
      // with a short deadline, and a stale one funds nothing.
      const quote = await quoteBuy(trade.listingId);
      await fundQuote(quote);
      await refresh();
    }, 'Payment sent.');

  const onRelease = trade =>
    guard(async () => {
      await submitRelease(trade);
      const updated = await syncTrade(trade.id);
      setTrades(prev => prev.map(t => (t.id === updated.id ? updated : t)));
    }, 'Released. The hint arrives once it confirms.');

  const onList = hint =>
    guard(async () => {
      const raw = window.prompt('Ask, in cents');
      const cents = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(cents)) return;
      await listHint(hint.id, cents);
      await refresh();
    }, 'Listed. You keep the hint either way.');

  const onCancel = listing =>
    guard(async () => {
      await cancelListing(listing.id);
      await refresh();
    });

  const onShowBids = async listing => {
    const book = await fetchBids(listing.id).catch(() => []);
    setBids(prev => ({ ...prev, [listing.id]: book }));
  };

  const onAccept = bid =>
    guard(async () => {
      await acceptBid(bid.id);
      await refresh();
    }, 'Accepted. The bidder pays next.');

  const sellable = hints.filter(h => !mine.some(l => l.hintId === h.id && l.status !== 'cancelled'));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10', background: 'var(--card)' }}>
        <Label dark>HINT MARKET</Label>
        <div style={{ fontFamily: BLACK, fontSize: 22, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>
          BUY DIRECTIONS
        </div>
      </div>

      <Tabs tab={tab} onTab={setTab} />

      {note && (
        <div style={{
          flexShrink: 0, padding: '10px 14px', borderBottom: '3px solid #0C0C10',
          background: 'rgba(255,213,31,.14)', fontFamily: MONO, fontSize: 10,
          fontWeight: 700, color: 'var(--cream)',
        }}>{note}</div>
      )}

      <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {tab === 'browse' && (
          listings.length === 0
            ? <Empty>Nothing for sale here yet.</Empty>
            : listings.map(l => (
              <ListingCard
                key={l.id}
                listing={l}
                onBuy={onBuy}
                onBid={onBid}
                busy={busy}
                trust={trust[l.sellerId]}
              />
            ))
        )}

        {tab === 'selling' && (
          <>
            <Label>YOUR HINTS</Label>
            <div style={{ height: 8 }} />
            {sellable.length === 0 && <Empty>No hints to sell. Dig for them.</Empty>}
            {sellable.map(h => (
              <div key={h.id} style={CARD}>
                {/* Safe to show in full: this is your own hint, not one on offer. */}
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, color: '#0C0C10' }}>
                  {describeHint(h.payload)}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, marginTop: 6, color: '#0C0C10', opacity: .6 }}>
                  {tierLabel(h.tier).toUpperCase()} · RIGHT {reliabilityPct(h)}% OF THE TIME
                </div>
                <div style={{ display: 'flex', marginTop: 10 }}>
                  <Button onClick={() => onList(h)} disabled={busy}>SELL A COPY</Button>
                </div>
              </div>
            ))}

            <div style={{ height: 14 }} />
            <Label>LISTED</Label>
            <div style={{ height: 8 }} />
            {mine.filter(l => l.status !== 'cancelled').map(l => (
              <div key={l.id} style={CARD}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <Label dark>{tierLabel(l.tier).toUpperCase()} · {l.zoneId}</Label>
                  <div style={{ fontFamily: BLACK, fontSize: 16, color: '#0C0C10' }}>{formatCents(l.askCents)}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button color="#29E6E6" onClick={() => onShowBids(l)} disabled={busy}>BIDS</Button>
                  <Button color="#FF3D3D" onClick={() => onCancel(l)} disabled={busy}>DELIST</Button>
                </div>
                {(bids[l.id] ?? []).map(b => (
                  <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                    <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: '#0C0C10', flex: 1 }}>
                      {formatCents(b.priceCents)}
                    </div>
                    <Button color="#B7FF3B" onClick={() => onAccept(b)} disabled={busy}>ACCEPT</Button>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {tab === 'trades' && (
          trades.length === 0
            ? <Empty>No trades yet.</Empty>
            : trades.map(t => (
              <TradeCard key={t.id} trade={t} onSync={onSync} onPay={onPay} onRelease={onRelease} />
            ))
        )}
      </div>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{
      padding: '24px 8px', textAlign: 'center', fontFamily: MONO, fontSize: 11,
      fontWeight: 700, letterSpacing: '.1em', color: 'var(--cream)', opacity: .5,
    }}>{children}</div>
  );
}
