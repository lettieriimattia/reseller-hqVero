// src/routes/templates.ts
// Pilastro 1: Template Engine — schema dinamico dei campi per categoria.
// I template di sistema vengono seedati al primo GET se non esistono.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireOwner } from '../middleware/rbac';
import { generateCategoryConfig } from '../services/ai.service';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// FieldDef: struttura di un singolo campo dinamico
// type 'text' | 'number' | 'select' | 'boolean'
// Il frontend (DynamicForm) legge questo array e renderizza gli input corretti.
const SYSTEM_TEMPLATES = [
  {
    name: 'Scarpe',
    icon: '👟',
    isSystem: true,
    fields: [
      { key: 'colore', label: 'Colore', type: 'text' },
      { key: 'materiale', label: 'Materiale', type: 'select', options: ['Pelle', 'Canvas', 'Mesh', 'Suede', 'Tessuto', 'Sintetico', 'Altro'] },
      { key: 'lace', label: 'Lacci', type: 'select', options: ['Originali', 'Sostituiti', 'Mancanti'] },
      { key: 'box', label: 'Scatola', type: 'select', options: ['Completa', 'Solo coperchio', 'Assente'] },
      { key: 'collab', label: 'Collab/Special', type: 'text' },
    ],
  },
  {
    name: 'Orologi',
    icon: '⌚',
    isSystem: true,
    fields: [
      { key: 'referenza', label: 'Referenza', type: 'text' },
      { key: 'cassa', label: 'Cassa (mm)', type: 'number', unit: 'mm' },
      { key: 'cinturino', label: 'Cinturino', type: 'select', options: ['Acciaio', 'Pelle', 'Rubber', 'NATO', 'Maglia', 'Silicone'] },
      { key: 'movimento', label: 'Movimento', type: 'select', options: ['Automatico', 'Quarzo', 'Manuale', 'Solare'] },
      { key: 'anno', label: 'Anno produzione', type: 'number' },
      { key: 'box_papers', label: 'Box & Papers', type: 'select', options: ['Full set', 'Solo box', 'Solo papers', 'No accessories'] },
    ],
  },
  {
    name: 'Vestiti',
    icon: '👕',
    isSystem: true,
    fields: [
      { key: 'colore', label: 'Colore', type: 'text' },
      { key: 'materiale', label: 'Materiale', type: 'text' },
      { key: 'anno', label: 'Anno/Stagione', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'select', options: ['Attaccati', 'Rimossi', 'Mai presenti'] },
      { key: 'made_in', label: 'Made in', type: 'text' },
    ],
  },
  {
    name: 'Pokemon',
    icon: '🃏',
    isSystem: true,
    fields: [
      { key: 'set', label: 'Set/Espansione', type: 'text' },
      { key: 'numero', label: 'Numero carta', type: 'text' },
      { key: 'grading', label: 'Grading', type: 'select', options: ['Raw', 'PSA 10', 'PSA 9', 'PSA 8', 'PSA 7', 'CGC 10', 'CGC 9.5', 'BGS 10', 'AGS 10'] },
      { key: 'lingua', label: 'Lingua', type: 'select', options: ['Italiano', 'Inglese', 'Giapponese', 'Francese', 'Tedesco', 'Spagnolo'] },
      { key: 'holo', label: 'Holo', type: 'boolean' },
      { key: 'reverse', label: 'Reverse Holo', type: 'boolean' },
    ],
  },
  {
    name: 'Sci',
    icon: '⛷️',
    isSystem: true,
    fields: [
      { key: 'lunghezza', label: 'Lunghezza (cm)', type: 'number', unit: 'cm' },
      { key: 'flex', label: 'Flex', type: 'select', options: ['Soft (60-70)', 'Medium (75-85)', 'Stiff (90-100)', 'Extra Stiff (105+)'] },
      { key: 'raggio', label: 'Raggio (m)', type: 'number', unit: 'm' },
      { key: 'attacchi', label: 'Attacchi inclusi', type: 'boolean' },
      { key: 'tipo', label: 'Tipo', type: 'select', options: ['All Mountain', 'Carving', 'Freestyle', 'Freeride', 'Race'] },
    ],
  },
  {
    name: 'Borse',
    icon: '👜',
    isSystem: true,
    fields: [
      { key: 'colore', label: 'Colore', type: 'text' },
      { key: 'materiale', label: 'Materiale', type: 'select', options: ['Pelle', 'Canvas', 'Denim', 'Nylon', 'Velluto', 'Altro'] },
      { key: 'hardware', label: 'Hardware', type: 'select', options: ['Gold', 'Silver', 'Palladium', 'Bronze', 'Ruthenium'] },
      { key: 'anno', label: 'Anno/Stagione', type: 'text' },
      { key: 'dustbag', label: 'Dustbag', type: 'boolean' },
      { key: 'receipt', label: 'Scontrino/Receipt', type: 'boolean' },
    ],
  },
];

// ==========================================
// GET /templates — lista tutti i template (seed automatico al primo accesso)
// ==========================================
router.get('/', authenticate, async (_req: AuthRequest, res: Response) => {
  try {
    // Seed template di sistema se non presenti (upsert idempotente)
    await Promise.all(
      SYSTEM_TEMPLATES.map(t =>
        prisma.categoryTemplate.upsert({
          where: { name: t.name },
          update: {},
          create: {
            name: t.name,
            icon: t.icon,
            isSystem: t.isSystem,
            fields: JSON.stringify(t.fields),
          },
        })
      )
    );

    const templates = await prisma.categoryTemplate.findMany({
      orderBy: { name: 'asc' },
    });
    res.json(templates);
  } catch (err: any) {
    logger.error('GET /templates error', { err: err.message });
    res.status(500).json({ error: 'Errore recupero template' });
  }
});

// ==========================================
// GET /templates/:name — template di una categoria specifica
// ==========================================
router.get('/:name', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const template = await prisma.categoryTemplate.findUnique({
      where: { name: req.params.name },
    });
    if (!template) return res.status(404).json({ error: 'Template non trovato' });
    res.json(template);
  } catch (err: any) {
    res.status(500).json({ error: 'Errore' });
  }
});

// ==========================================
// POST /templates/auto — crea una categoria al volo generando i campi con l'IA.
// Usato quando l'utente scrive a mano una categoria nuova o la foto ne rileva una
// non ancora presente. Idempotente: se la categoria esiste già, la restituisce.
// ==========================================
router.post('/auto', authenticate, requireOwner, async (req: AuthRequest, res: Response) => {
  try {
    const rawName = (req.body?.name || '').toString().trim();
    if (!rawName || rawName.length > 50) {
      return res.status(400).json({ error: 'Nome categoria non valido' });
    }
    // Match case-insensitive su una categoria esistente (lista piccola → filtro in JS)
    const allTemplates = await prisma.categoryTemplate.findMany();
    const existing = allTemplates.find(t => t.name.toLowerCase() === rawName.toLowerCase());
    if (existing) return res.json({ ...existing, created: false });

    // Genera la configurazione campi con l'IA (fallback a un set minimo se l'IA fallisce)
    let icon: string | null = null;
    let fields: any[] = [
      { key: 'colore', label: 'Colore', type: 'text' },
      { key: 'materiale', label: 'Materiale', type: 'text' },
    ];
    try {
      const config = await generateCategoryConfig(rawName);
      if (config) {
        icon = config.emoji || null;
        if (Array.isArray(config.fields) && config.fields.length > 0) {
          fields = config.fields.map((f: any) => ({
            key: f.name || f.key,
            label: f.label || f.name,
            type: f.type === 'number' || f.type === 'select' || f.type === 'boolean' ? f.type : 'text',
            ...(Array.isArray(f.options) && f.options.length ? { options: f.options } : {}),
          }));
        }
      }
    } catch (err: any) {
      logger.warn('generateCategoryConfig fallita (uso fallback)', { err: err?.message, name: rawName });
    }

    const created = await prisma.categoryTemplate.create({
      data: { name: rawName, icon, fields: JSON.stringify(fields), isSystem: false },
    });
    res.json({ ...created, created: true });
  } catch (err: any) {
    if (err.code === 'P2002') {
      const t = await prisma.categoryTemplate.findUnique({ where: { name: (req.body?.name || '').toString().trim() } });
      if (t) return res.json({ ...t, created: false });
    }
    logger.error('POST /templates/auto error', { err: err.message });
    res.status(500).json({ error: 'Errore creazione categoria' });
  }
});

// ==========================================
// POST /templates — crea template custom (solo OWNER)
// ==========================================
router.post('/', authenticate, requireOwner, async (req: AuthRequest, res: Response) => {
  try {
    const { name, icon, fields } = req.body;
    if (!name?.trim() || !Array.isArray(fields) || fields.length === 0) {
      return res.status(400).json({ error: 'name e fields[] obbligatori' });
    }
    const t = await prisma.categoryTemplate.create({
      data: { name: name.trim(), icon: icon || null, fields: JSON.stringify(fields), isSystem: false },
    });
    res.json(t);
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'Template con questo nome già esistente' });
    res.status(500).json({ error: 'Errore creazione template' });
  }
});

// ==========================================
// PUT /templates/:name — aggiorna template custom (solo OWNER, non system)
// ==========================================
router.put('/:name', authenticate, requireOwner, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.categoryTemplate.findUnique({ where: { name: req.params.name } });
    if (!existing) return res.status(404).json({ error: 'Template non trovato' });
    if (existing.isSystem) return res.status(403).json({ error: 'I template di sistema non sono modificabili' });

    const { icon, fields } = req.body;
    const updated = await prisma.categoryTemplate.update({
      where: { name: req.params.name },
      data: {
        icon: icon !== undefined ? icon : existing.icon,
        fields: Array.isArray(fields) ? JSON.stringify(fields) : existing.fields,
      },
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Errore modifica template' });
  }
});

// ==========================================
// DELETE /templates/:name — elimina template custom (solo OWNER, non system)
// ==========================================
router.delete('/:name', authenticate, requireOwner, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.categoryTemplate.findUnique({ where: { name: req.params.name } });
    if (!existing) return res.status(404).json({ error: 'Template non trovato' });
    if (existing.isSystem) return res.status(403).json({ error: 'I template di sistema non possono essere eliminati' });
    await prisma.categoryTemplate.delete({ where: { name: req.params.name } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Errore eliminazione template' });
  }
});

export default router;
