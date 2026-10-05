export function nextAvatar(previous?: number | null): number {
  const choices = [0, 1, 2, 3, 4, 5].filter(avatar => avatar !== previous);
  return choices[Math.floor(Math.random() * choices.length)]!;
}
