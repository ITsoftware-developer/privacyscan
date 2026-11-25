// Nederlandse namen voor de soorten gegevens die Have I Been Pwned noemt ("Email
// addresses", "Passwords", ...). Wat we niet kennen, laten we staan zoals HIBP het
// schrijft. Een Map in plaats van een gewoon object, zodat een naam als "constructor"
// nooit per ongeluk iets van JavaScript zelf teruggeeft.
const LABELS = new Map([
  ['Email addresses', 'E-mailadressen'],
  ['Passwords', 'Wachtwoorden'],
  ['Password hints', 'Wachtwoordhints'],
  ['Usernames', 'Gebruikersnamen'],
  ['Names', 'Namen'],
  ['IP addresses', 'IP-adressen'],
  ['Phone numbers', 'Telefoonnummers'],
  ['Physical addresses', 'Fysieke adressen'],
  ['Dates of birth', 'Geboortedatums'],
  ['Genders', 'Geslacht'],
  ['Ages', 'Leeftijden'],
  ['Geographic locations', 'Locaties'],
  ['Social media profiles', 'Socialemediaprofielen'],
  ['Credit cards', 'Creditcards'],
  ['Partial credit card data', 'Deel van creditcardgegevens'],
  ['Bank account numbers', 'Bankrekeningnummers'],
  ['Security questions and answers', 'Beveiligingsvragen en antwoorden'],
  ['Auth tokens', 'Inlogtokens'],
  ['Private messages', 'Privéberichten'],
  ['Purchases', 'Aankopen'],
  ['Employers', 'Werkgevers'],
  ['Job titles', 'Functietitels'],
  ['Device information', 'Apparaatgegevens'],
  ['Browser user agent details', 'Browsergegevens'],
  ['Avatars', 'Profielfoto\'s'],
]);

export function dataClassLabel(name) {
  return LABELS.get(name) ?? name;
}
