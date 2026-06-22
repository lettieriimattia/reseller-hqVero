// frontend/src/i18n.ts
// Sistema lingue (i18n) leggero. La lingua è in localStorage ('hq-lang') e selezionabile
// in Impostazioni. La copertura cresce a fasi: qui ci sono le chiavi delle schermate
// principali (navigazione, dashboard, impostazioni). Le stringhe non ancora tradotte
// ricadono sull'italiano (nessun testo "rotto").

export type Lang = 'it' | 'en' | 'es' | 'de';

// `ready`: la lingua appare nel selettore SOLO quando è completa.
// Italiano = lingua base (sempre). Inglese si attiva quando la traduzione è finita;
// poi Tedesco, poi Spagnolo.
export const LANGUAGES: { code: Lang; label: string; flag: string; ready: boolean }[] = [
  { code: 'it', label: 'Italiano', flag: '🇮🇹', ready: true },
  { code: 'en', label: 'English', flag: '🇬🇧', ready: false },
  { code: 'es', label: 'Español', flag: '🇪🇸', ready: false },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪', ready: false },
];

type Dict = Record<string, string>;

const it: Dict = {
  'nav.dashboard': 'Dashboard',
  'nav.magazzino': 'Magazzino',
  'nav.market': 'Compra',
  'nav.messages': 'Messaggi',
  'nav.analytics': 'Analytics',
  'nav.tracking': 'Tracking',
  'nav.settings': 'Impostazioni',
  'nav.wallet': 'Portafoglio',
  'dash.hello': 'Ciao',
  'dash.personal': 'Personale',
  'dash.personalQuotas': 'Quote personali',
  'dash.profit': 'Profitto',
  'dash.allWarehouses': 'Tutti i magazzini',
  'dash.totalProfit': 'Profitto totale',
  'dash.warehouseProfit': 'Profitto magazzino',
  'dash.stock': 'Stock',
  'dash.pieces': 'pezzi',
  'dash.sales': 'Vendite',
  'dash.revenue': 'ricavi',
  'dash.week': 'Settimana',
  'dash.sale': 'vendita',
  'dash.salesPlural': 'vendite',
  'dash.toShip': 'Da spedire',
  'dash.inTransit': 'in transito',
  'dash.stale': 'Fermi',
  'dash.over30': 'oltre 30gg',
  'dash.detail': 'Dettaglio',
  'dash.see': 'Vedi',
  'dash.departments': 'Reparti',
  'common.add': 'Aggiungi',
  'common.save': 'Salva',
  'common.cancel': 'Annulla',
  'common.close': 'Chiudi',
  'settings.language': 'Lingua',
  'settings.languageDesc': 'Scegli la lingua dell\'app.',
};

const en: Dict = {
  'nav.dashboard': 'Dashboard',
  'nav.magazzino': 'Inventory',
  'nav.market': 'Shop',
  'nav.messages': 'Messages',
  'nav.analytics': 'Analytics',
  'nav.tracking': 'Tracking',
  'nav.settings': 'Settings',
  'nav.wallet': 'Wallet',
  'dash.hello': 'Hi',
  'dash.personal': 'Personal',
  'dash.personalQuotas': 'Your share',
  'dash.profit': 'Profit',
  'dash.allWarehouses': 'All warehouses',
  'dash.totalProfit': 'Total profit',
  'dash.warehouseProfit': 'Warehouse profit',
  'dash.stock': 'Stock',
  'dash.pieces': 'items',
  'dash.sales': 'Sales',
  'dash.revenue': 'revenue',
  'dash.week': 'This week',
  'dash.sale': 'sale',
  'dash.salesPlural': 'sales',
  'dash.toShip': 'To ship',
  'dash.inTransit': 'in transit',
  'dash.stale': 'Stale',
  'dash.over30': 'over 30 days',
  'dash.detail': 'Details',
  'dash.see': 'View',
  'dash.departments': 'Departments',
  'common.add': 'Add',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'settings.language': 'Language',
  'settings.languageDesc': 'Choose the app language.',
};

const es: Dict = {
  'nav.dashboard': 'Panel',
  'nav.magazzino': 'Inventario',
  'nav.market': 'Comprar',
  'nav.messages': 'Mensajes',
  'nav.analytics': 'Analíticas',
  'nav.tracking': 'Seguimiento',
  'nav.settings': 'Ajustes',
  'nav.wallet': 'Cartera',
  'dash.hello': 'Hola',
  'dash.personal': 'Personal',
  'dash.personalQuotas': 'Tu parte',
  'dash.profit': 'Beneficio',
  'dash.allWarehouses': 'Todos los almacenes',
  'dash.totalProfit': 'Beneficio total',
  'dash.warehouseProfit': 'Beneficio almacén',
  'dash.stock': 'Stock',
  'dash.pieces': 'artículos',
  'dash.sales': 'Ventas',
  'dash.revenue': 'ingresos',
  'dash.week': 'Esta semana',
  'dash.sale': 'venta',
  'dash.salesPlural': 'ventas',
  'dash.toShip': 'Por enviar',
  'dash.inTransit': 'en tránsito',
  'dash.stale': 'Parados',
  'dash.over30': 'más de 30 días',
  'dash.detail': 'Detalle',
  'dash.see': 'Ver',
  'dash.departments': 'Departamentos',
  'common.add': 'Añadir',
  'common.save': 'Guardar',
  'common.cancel': 'Cancelar',
  'common.close': 'Cerrar',
  'settings.language': 'Idioma',
  'settings.languageDesc': 'Elige el idioma de la app.',
};

const de: Dict = {
  'nav.dashboard': 'Übersicht',
  'nav.magazzino': 'Lager',
  'nav.market': 'Kaufen',
  'nav.messages': 'Nachrichten',
  'nav.analytics': 'Analysen',
  'nav.tracking': 'Sendungen',
  'nav.settings': 'Einstellungen',
  'nav.wallet': 'Wallet',
  'dash.hello': 'Hallo',
  'dash.personal': 'Persönlich',
  'dash.personalQuotas': 'Dein Anteil',
  'dash.profit': 'Gewinn',
  'dash.allWarehouses': 'Alle Lager',
  'dash.totalProfit': 'Gesamtgewinn',
  'dash.warehouseProfit': 'Lagergewinn',
  'dash.stock': 'Bestand',
  'dash.pieces': 'Stück',
  'dash.sales': 'Verkäufe',
  'dash.revenue': 'Umsatz',
  'dash.week': 'Diese Woche',
  'dash.sale': 'Verkauf',
  'dash.salesPlural': 'Verkäufe',
  'dash.toShip': 'Zu versenden',
  'dash.inTransit': 'unterwegs',
  'dash.stale': 'Liegt',
  'dash.over30': 'über 30 Tage',
  'dash.detail': 'Details',
  'dash.see': 'Ansehen',
  'dash.departments': 'Abteilungen',
  'common.add': 'Hinzufügen',
  'common.save': 'Speichern',
  'common.cancel': 'Abbrechen',
  'common.close': 'Schließen',
  'settings.language': 'Sprache',
  'settings.languageDesc': 'Wähle die App-Sprache.',
};

const DICTS: Record<Lang, Dict> = { it, en, es, de };

export function getLang(): Lang {
  try {
    const l = localStorage.getItem('hq-lang') as Lang | null;
    if (l && DICTS[l]) return l;
  } catch {}
  return 'it';
}

export function setLangStorage(l: Lang) {
  try { localStorage.setItem('hq-lang', l); } catch {}
}

// Traduce una chiave nella lingua data. Fallback: italiano → chiave stessa.
export function translate(lang: Lang, key: string): string {
  return DICTS[lang]?.[key] ?? DICTS.it[key] ?? key;
}
