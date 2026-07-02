import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, ReferenceLine } from 'recharts';

// Grafico trend ricavi/profitto — stile "spezzata con puntini + sfumatura" (come la dashboard
// di riferimento), nei nostri colori (viola). Estratto in un chunk separato e caricato in lazy
// così recharts non pesa sul bundle iniziale.
export default function TrendChart({ trendData }: { trendData: any[] }) {
  // Media del profitto → linea tratteggiata tenue (come nella foto).
  const profits = (trendData || []).map(d => Number(d?.Profitto) || 0);
  const avg = profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={trendData} margin={{ top: 12, right: 6, left: 6, bottom: 0 }}>
        <defs>
          {/* Sfumatura viola sotto la linea principale (Profitto) */}
          <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6b54c6" stopOpacity={0.5} />
            <stop offset="55%" stopColor="#6b54c6" stopOpacity={0.14} />
            <stop offset="100%" stopColor="#6b54c6" stopOpacity={0} />
          </linearGradient>
          {/* Velo tenue per i Ricavi (serie secondaria, sotto) */}
          <linearGradient id="ricaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8a78d9" stopOpacity={0.12} />
            <stop offset="100%" stopColor="#8a78d9" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Assi nascosti: look pulito come nella foto (niente etichette/griglia) */}
        <XAxis dataKey="date" hide />
        <YAxis hide domain={['auto', 'auto']} />

        <Tooltip
          contentStyle={{ backgroundColor: 'rgba(12,10,20,0.96)', border: '1px solid rgba(107,84,198,0.4)', borderRadius: 12, fontSize: 12 }}
          labelStyle={{ color: '#8a78d9', fontWeight: 'bold' }}
          itemStyle={{ color: '#e9e3ff' }} />

        {/* Linea media (tratteggiata, tenue) */}
        <ReferenceLine y={avg} stroke="#6b54c6" strokeOpacity={0.35} strokeDasharray="4 4" />

        {/* Ricavi: velo secondario di sfondo (linea un po' più marcata per leggibilità) */}
        <Area type="linear" dataKey="Ricavi" stroke="#8a78d9" strokeOpacity={0.45} strokeWidth={2}
          fill="url(#ricaGrad)" dot={false} isAnimationActive={false} />

        {/* Profitto: spezzata viola in primo piano — linea PIÙ SPESSA (leggibile su schermi HiDPI) */}
        <Area type="linear" dataKey="Profitto" stroke="#6b54c6" strokeWidth={3.25} fill="url(#profGrad)"
          dot={{ r: 2.5, fill: '#6b54c6', strokeWidth: 0 }}
          activeDot={{ r: 5, fill: '#c4b5fd', stroke: '#6b54c6', strokeWidth: 2 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
