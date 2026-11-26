export type GamePhase = "playing" | "won" | "lost";

export type InventoryProjection = {
  readonly itemId: string;
  readonly quantity: number;
};

export type GameState = {
  /** Set from the UI\'s pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  abilityCooldown: number;
  abilityUses: number;
  baseDamage: number;
  damage: number;
  damageHits: number;
  deaths: number;
  dropProof: number;
  dropSequence: string;
  enemiesDefeated: number;
  equippedItem: string;
  gameOver: number;
  gameWon: number;
  health: number;
  inventory: string[];
  inventoryFullRefused: number;
  inventorySlots: InventoryProjection[];
  lastDamage: number;
  lastDrop: string;
  lineOfSightBlocked: number;
  modifierActive: number;
  pendingLoot: string;
  pendingLootItem: string;
  pendingLootQuantity: number;
  phase: GamePhase;
  playerX: number;
  playerY: number;
  playerZ: number;
  room: number;
  saveCount: number;
  visibleEnemyAggro: number;
  wallEnemyAggro: number;
};
