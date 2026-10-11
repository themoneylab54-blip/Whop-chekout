import type { Lang } from "./i18n-core";

/*
 * The checkout's error screen texts in every language (part of the checkout's texts: LABEL_TEXTS
 * spreads them in), kept apart for the error screen itself (app/c/[id]/error), which picks its
 * language in the browser and must not download every text of the checkout. Pure.
 */

export const ERROR_SCREEN_TEXTS = {
  fr: {
    errorTitle: "Un problème est survenu",
    errorBody: "La page de paiement n'a pas pu se charger. Aucun paiement n'a été effectué.",
    retry: "Réessayer",
    backToStore: "Retour à la boutique",
  },
  en: {
    errorTitle: "Something went wrong",
    errorBody: "The checkout page couldn't load. You have not been charged.",
    retry: "Try again",
    backToStore: "Back to store",
  },
  de: {
    errorTitle: "Ein Problem ist aufgetreten",
    errorBody: "Die Zahlungsseite konnte nicht geladen werden. Es wurde nichts abgebucht.",
    retry: "Erneut versuchen",
    backToStore: "Zurück zum Shop",
  },
  es: {
    errorTitle: "Se ha producido un problema",
    errorBody: "No se pudo cargar la página de pago. No se ha realizado ningún cargo.",
    retry: "Reintentar",
    backToStore: "Volver a la tienda",
  },
  it: {
    errorTitle: "Si è verificato un problema",
    errorBody: "Impossibile caricare la pagina di pagamento. Non è stato effettuato alcun addebito.",
    retry: "Riprova",
    backToStore: "Torna al negozio",
  },
  nl: {
    errorTitle: "Er is een probleem opgetreden",
    errorBody: "De betaalpagina kon niet worden geladen. Er is niets afgeschreven.",
    retry: "Opnieuw proberen",
    backToStore: "Terug naar de winkel",
  },
} satisfies Record<Lang, Record<string, string>>;
