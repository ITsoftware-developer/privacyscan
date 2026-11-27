// De diensten waar de site aanvragen naartoe stuurt. De beheerpagina telt per dienst de
// aanvragen (monitor.js), het systeemlog noemt ze bij naam (events.js), en een paar ervan kun je
// pauzeren (controls.js).
//
//   pausable  kan de beheerder deze dienst tijdelijk uitzetten? Pwned Passwords niet: die controle
//             bij het aanmaken van een account slaat zichzelf al over als de dienst niet antwoordt.
export const SERVICES = {
  brave: { id: 'brave', name: 'Brave Search', pausable: true },
  xon: { id: 'xon', name: 'XposedOrNot', pausable: true },
  hibp: { id: 'hibp', name: 'Have I Been Pwned', pausable: true },
  'pwned-passwords': { id: 'pwned-passwords', name: 'Pwned Passwords', pausable: false },
  // Het AI-model (zie ai/). Ollama draait standaard op je eigen computer: dan gaat er niets naar buiten.
  ollama: { id: 'ollama', name: 'Ollama (AI-model)', pausable: true },
};

export const SERVICE_IDS = Object.keys(SERVICES);

export function serviceName(id) {
  return Object.hasOwn(SERVICES, id) ? SERVICES[id].name : 'Onbekende dienst';
}
