import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, ReferenceLine } from 'recharts';

// Grafico trend ricavi/profitto — stile premium "tech minimal" (Linear/Vercel): curve MORBIDE,
// area sfumata profonda e un GLOW/ombra sotto la linea del profitto per dare profondità. Nessun
// puntino sulla linea (pulito) — il punto compare solo al passaggio del mouse. Colori: viola.
// Estratto in un chunk lazy così recharts non pesa sul bundle iniziale.
export default function TrendChart({ trendData }: { trendData: any[] }) {
  // Media del profitto → linea tratteggiata tenue di riferimento.
  const profits = (trendData || []).map(d => Number(d?.Profitto) || 0);
  const avg = profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={trendData} margin={{ top: 16, right: 8, left: 8, bottom: 4 }}>
        <defs>
          {/* Sfumatura viola sotto la linea principale (Profitto) — più profonda per dare volume */}
          <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dbe2ea" stopOpacity={0.5} />
            <stop offset="45%" stopColor="#aeb9c6" stopOpacity={0.16} />
            <stop offset="100%" stopColor="#aeb9c6" stopOpacity={0} />
          </linearGradient>
          {/* Velo tenue per i Ricavi (serie secondaria, azzurro-acciaio) */}
          <linearGradient id="ricaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5e86b5" stopOpacity={0.16} />
            <stop offset="100%" stopColor="#5e86b5" stopOpacity={0} />
          </linearGradient>
          {/* Ombra/glow morbido sotto la linea del profitto → profondità premium */}
          <filter id="lineGlow" x="-20%" y="-40%" width="140%" height="200%">
            <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#8397aa" floodOpacity="0.45" />
          </filter>
          {/* Sfumatura sulla linea stessa (chiaro in alto → accento in basso) per un filo di lucentezza */}
          <linearGradient id="profStroke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#eef1f5" />
            <stop offset="100%" stopColor="#b7c2ce" />
          </linearGradient>
        </defs>

        {/* Assi nascosti: look pulito (niente etichette/griglia) */}
        <XAxis dataKey="date" hide />
        <YAxis hide domain={['auto', 'auto']} />

        <Tooltip
          cursor={{ stroke: 'rgba(131,151,170,0.35)', strokeWidth: 1 }}
          contentStyle={{ backgroundColor: 'rgba(14,15,18,0.94)', backdropFilter: 'blur(12px)', border: '1px solid rgba(131,151,170,0.35)', borderRadius: 14, fontSize: 12, boxShadow: '0 12px 40px -8px rgba(0,0,0,0.6)', padding: '10px 12px' }}
          labelStyle={{ color: '#cbd4dd', fontWeight: 800, marginBottom: 4 }}
          itemStyle={{ color: '#e8ebee', fontWeight: 600 }}
          formatter={(value: any, name: any) => [`${Math.round(Number(value) || 0).toLocaleString('it-IT')}€`, name]} />

        {/* Linea media (tratteggiata, tenue) */}
        <ReferenceLine y={avg} stroke="#8397aa" strokeOpacity={0.28} strokeDasharray="3 5" />

        {/* Ricavi: linea secondaria AZZURRO-ACCIAIO (tinta distinta dal profitto argento) */}
        <Area type="linear" dataKey="Ricavi" stroke="#5e86b5" strokeOpacity={0.85} strokeWidth={2}
          fill="url(#ricaGrad)" dot={false} isAnimationActive={false} />

        {/* Profitto: spezzata viola ANGOLARE (niente raccordi curvi) in primo piano, con glow/ombra
            e stroke sfumato. Nessun puntino fisso → il punto compare solo all'hover (activeDot). */}
        <Area type="linear" dataKey="Profitto" stroke="url(#profStroke)" strokeWidth={3}
          fill="url(#profGrad)" dot={false} style={{ filter: 'url(#lineGlow)' }}
          activeDot={{ r: 5, fill: '#eef1f4', stroke: '#b7c2ce', strokeWidth: 2 }}
          isAnimationActive={true} animationDuration={700} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
