export type Lang = "en" | "fr";

export function normalizeLang(input?: string | null): Lang {
  const value = (input ?? "").toLowerCase();
  return value.startsWith("fr") ? "fr" : "en";
}

export function pickLang(...values: Array<string | null | undefined>): Lang {
  for (const value of values) {
    if (value) return normalizeLang(value);
  }
  return "en";
}

export const apiText = {
  reportAnalyzed: {
    en: "Report analyzed. See GET /api/reports/:id for the full result.",
    fr: "Signalement analysé. Consultez GET /api/reports/:id pour le résultat complet.",
  },
  reportReceived: {
    en: "Report received. Analyzing...",
    fr: "Signalement reçu. Analyse en cours...",
  },
  signupSuccess: {
    en:
      "Your institution has been registered and is pending review. An administrator " +
      "will contact you to activate document-signing.",
    fr:
      "Votre institution a été enregistrée et attend une revue. Un administrateur " +
      "vous contactera pour activer la signature de documents.",
  },
  citizenSignupSuccess: {
    en: "Your account has been created. You can now sign in.",
    fr: "Votre compte a été créé. Vous pouvez maintenant vous connecter.",
  },
  fileRequired: {
    en: "file is required (multipart/form-data).",
    fr: "Le fichier est requis (multipart/form-data).",
  },
  genericError: {
    en: "Something went wrong. Please try again.",
    fr: "Une erreur est survenue. Veuillez réessayer.",
  },
  rateLimitedExtension: {
    en: "Too many checks from this network. Please wait a bit and try again.",
    fr: "Trop de vérifications depuis ce réseau. Patientez un moment puis réessayez.",
  },
  rateLimitedVerify: {
    en: "Too many verification checks from this network. Please wait a bit and try again.",
    fr: "Trop de vérifications de document depuis ce réseau. Patientez un moment puis réessayez.",
  },
} satisfies Record<string, Record<Lang, string>>;

export function tt(key: keyof typeof apiText, lang: Lang): string {
  return apiText[key][lang] ?? apiText[key].en;
}

export const riskCopy = {
  urgent: {
    en: "Uses urgent, time-pressured language.",
    fr: "Utilise un langage urgent ou pressant.",
  },
  payment: {
    en: "Mentions a payment or mobile-money transfer.",
    fr: "Mentionne un paiement ou un transfert Mobile Money.",
  },
  personalInfo: {
    en: "Asks for a password, PIN, or personal ID details.",
    fr: "Demande un mot de passe, un PIN ou des informations personnelles.",
  },
  link: {
    en: "Contains a link that could not be independently checked yet.",
    fr: "Contient un lien qui n'a pas encore été vérifié indépendamment.",
  },
  noHighRisk: {
    en: "No high-risk keywords detected, but this has not been reviewed by a person yet.",
    fr: "Aucun mot-clé à haut risque détecté, mais une personne ne l'a pas encore revu.",
  },
  claimedTimeInFuture: {
    en: "Claims a mobile-money transaction happened at a time that hasn't occurred yet — a common sign of a faked payment message.",
    fr: "Prétend qu'une transaction Mobile Money a eu lieu à une heure qui n'est pas encore arrivée — signe fréquent d'un faux message de paiement.",
  },
  claimedTimeStale: {
    en: "The claimed transaction time is much earlier than now, which can mean an old payment message is being reused.",
    fr: "L'heure de transaction indiquée est bien antérieure à maintenant, ce qui peut signifier qu'un ancien message de paiement est réutilisé.",
  },
  recommendedAction: {
    en: "Do not send money or share personal information until this has been verified.",
    fr: "N'envoyez pas d'argent et ne partagez pas d'informations personnelles avant vérification.",
  },
} satisfies Record<string, Record<Lang, string>>;

export function trRisk(key: keyof typeof riskCopy, lang: Lang): string {
  return riskCopy[key][lang] ?? riskCopy[key].en;
}
