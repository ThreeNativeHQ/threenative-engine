type PlaytestEvent = {
  readonly [key: string]: string;
  readonly entity: string;
  readonly name: string;
};

const pendingEvents: PlaytestEvent[] = [];

export function emitPlaytestEvent(event: PlaytestEvent): void {
  pendingEvents.push(event);
}

export function drainPlaytestEvents(): PlaytestEvent[] {
  return pendingEvents.splice(0);
}
