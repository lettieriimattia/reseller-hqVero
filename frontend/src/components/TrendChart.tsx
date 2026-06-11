import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

// Grafico trend ricavi/profitto — estratto in un chunk separato e caricato in lazy
// così l'intera libreria recharts non pesa sul bundle iniziale.
export default function TrendChart({ trendData }: { trendData: any[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={trendData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff4d00" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#ff4d00" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="ricaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" stroke="#333" fontSize={10} tickLine={false} axisLine={false} />
        <YAxis stroke="#333" fontSize={10} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #222', borderRadius: 12, fontSize: 12 }}
          labelStyle={{ color: '#aaa', fontWeight: 'bold' }} />
        <Area type="monotone" dataKey="Ricavi" stroke="#22c55e" fill="url(#ricaGrad)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="Profitto" stroke="#ff4d00" fill="url(#profGrad)" strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
