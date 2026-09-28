# Whop Checkout pour Shopify

Ton propre checkout brandé pour tes boutiques Shopify, encaissé par **ton compte Whop**. Le principe est le même que Crisp Checkout, mais l'outil t'appartient et il est réservé à tes boutiques.

```
Boutique Shopify ── script (installé automatiquement) ── intercepte « Paiement »
      │  lit le panier (/cart.js)
      ▼
Ton checkout  /c/<id>   ← design du builder, livraison, codes promo, options
      │  « Continuer vers le paiement »
      ▼
Formulaire de paiement Whop intégré (carte, Apple Pay, Google Pay…)
      │  webhook payment.succeeded (signé)
      ▼
Commande PAYÉE créée dans Shopify (client, lignes, livraison, stock décrémenté,
e-mail de confirmation Shopify) → page de remerciement → retour boutique (panier vidé)
```

## ⚠️ À lire avant de mettre en ligne

- **Shopify interdit de contourner son checkout.** Les conditions de l'App Store (règle 1.1.2) et l'API License interdisent de contourner le checkout Shopify pour ensuite enregistrer les commandes via l'API. Crisp, Lasso et les autres outils du genre le font quand même, avec une app custom par boutique, jamais publiée. Le risque existe (app bloquée, boutique suspendue) et tu l'acceptes en connaissance de cause. Le bouton **Désactiver** remet le checkout Shopify natif instantanément.
- **Whop n'est pas un merchant of record complet par défaut.** Pour que Whop collecte et reverse la TVA, active « Whop collects & remits » dans les réglages fiscaux Whop. Vérifie aussi que ta catégorie de produits est autorisée par Whop.

## Installation (une fois)

### 1. Base de données et hébergement

- **Base de données :** une base Postgres (Neon, Supabase ou Vercel Postgres, l'offre gratuite suffit pour démarrer).
- **Hébergement :** Vercel ou tout hébergeur Node 20+. L'URL doit être en **HTTPS**, car Shopify et Whop l'appellent.

### 2. Variables d'environnement

Copie `.env.example` en `.env` (ou dans les réglages Vercel) :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | URL Postgres |
| `APP_URL` | URL publique de l'app, sans `/` final (ex. `https://checkout.monsite.com`) |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`. Chiffre les secrets Shopify et Whop. **Ne la change plus jamais** une fois des boutiques connectées. |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `OPERATOR_RESEND_API_KEY` / `OPERATOR_EMAIL_FROM` | Facultatif : compte Resend de l'opérateur pour les e-mails clients (codes « Déjà client ? », décisions de sinistre) des boutiques sans leur propre clé. Réglable aussi dans Réglages › Réseau. |
| `SENTRY_DSN` | Facultatif : suivi des erreurs inattendues dans Sentry (voir « Suivi des erreurs » plus bas). |
| `SENTRY_SAMPLE_RATE` | Facultatif : part des erreurs envoyées à Sentry, de `0` à `1` (défaut `1`). |

### 3. Déploiement sur Vercel (sans terminal)

1. Sur **vercel.com** : **Add New → Project**, puis importe ce dépôt (GitHub ou GitLab).
2. Onglet **Storage → Create Database → Neon (Postgres)**, et connecte la base au projet. Vérifie que la variable s'appelle bien `DATABASE_URL`.
3. Dans **Settings → Environment Variables**, ajoute `APP_URL`, `ENCRYPTION_KEY` et `SESSION_SECRET`.
4. Clique sur **Deploy**. Les tables sont créées automatiquement : le script `vercel-build` lance `prisma migrate deploy`.
5. Ouvre `APP_URL/setup` pour créer ton compte admin. **Cette page ne sert qu'une fois** : elle se désactive dès que le compte existe.

Sur un autre hébergeur :

```bash
npm install
npm run db:deploy        # crée les tables
npm run build && npm start
```

Le compte admin se crée ensuite via `/setup`. Pour réinitialiser un mot de passe : `npm run admin:create -- toi@mail.com 'nouveau-mot-de-passe'`.

### 4. Maintenance automatique et surveillance (obligatoire avant la mise en ligne)

La « maintenance » (`/api/cron/tick`) rattrape tout ce qu'un webhook manqué ou une panne laisse derrière : paiements Whop non reçus, commandes Shopify non créées, remboursements et litiges à reporter, alertes non délivrées. **Sans elle, rien de tout cela n'est rattrapé.**

> **Obligatoire en production : un planificateur externe toutes les 5 minutes.** Le cron de `vercel.json` ne passe qu'**une fois par jour** : c'est tout ce que le plan Vercel **Hobby** (gratuit) autorise — un cron plus fréquent y fait **échouer le déploiement**, ne le modifie donc pas. Configure un service externe gratuit — [cron-job.org](https://cron-job.org) (en-têtes personnalisés gratuits) ou UptimeRobot / Better Stack — qui appelle **`GET APP_URL/api/cron/tick` toutes les 5 minutes avec l'en-tête `Authorization: Bearer <CRON_SECRET>`** (jamais le secret dans l'URL). Le workflow GitHub Actions ci-dessous est un filet de secours, pas un planificateur fiable (retards de 5 à 30 min, passages sautés). Sans planificateur à 5 minutes : paiements manqués rattrapés en retard, tâches d'argent reportées (`/api/health` passe « down » quand l'une d'elles n'a pas tourné depuis 1 h) et preuves de litige envoyées tard.
>
> **Plan Vercel Pro :** les crons y peuvent tourner toutes les minutes. Si tu passes en Pro, tu peux remplacer le planificateur externe en mettant `"schedule": "*/5 * * * *"` dans `vercel.json` (Vercel envoie lui-même `Authorization: Bearer $CRON_SECRET`) ; garde alors le moniteur de `/api/health`.

1. Génère un secret (`openssl rand -base64 32`) et ajoute-le à Vercel sous le nom `CRON_SECRET`.
2. Planificateur de secours : le workflow GitHub Actions `.github/workflows/tick.yml` (« Background tick ») appelle `/api/cron/tick` toutes les 10 minutes. Dans le dépôt GitHub, **Settings → Secrets and variables → Actions**, ajoute `APP_URL` (ex. `https://checkout.monsite.com`) et le même `CRON_SECRET`. Sans ces secrets, le workflow ne fait rien. (Tout autre service de cron qui appelle l'URL avec l'en-tête `Authorization: Bearer <CRON_SECRET>` convient aussi.)
3. Surveillance externe (**obligatoire**, pas un bonus) : configure un moniteur de disponibilité (UptimeRobot, Better Stack…) sur `APP_URL/api/health` **toutes les 5 minutes**, avec une alerte si la réponse n'est pas 200 (et, si ton moniteur sait lire le corps, une alerte plus douce sur `"status":"degraded"`). Réponses détaillées plus bas.
4. Planificateur à 5 minutes (**obligatoire**, voir l'encadré ci-dessus) : un moniteur ou un cron externe sur `APP_URL/api/cron/tick` toutes les 5 minutes. Avec l'en-tête `Authorization: Bearer <CRON_SECRET>` (Better Stack, cron-job.org et les offres payantes d'UptimeRobot savent ajouter un en-tête), chaque appel lance une maintenance complète ; sans en-tête (UptimeRobot gratuit), l'appel lance quand même une maintenance si la dernière a plus de 4 minutes — ne mets jamais le secret dans l'URL. La maintenance ne tourne qu'une fois à la fois : deux planificateurs ne font jamais le travail en double.

**Pourquoi GitHub Actions seul ne suffit pas :**
- GitHub **désactive les workflows planifiés d'un dépôt sans activité (commit) depuis 60 jours**. Le workflow se ré-active lui-même à chaque passage (étape « Keep the schedule alive », permission `actions: write`), mais s'il a été désactivé malgré tout (e-mail de GitHub « scheduled workflow disabled », ou tuile « Maintenance automatique » en rouge) : **Actions → Background tick → Enable workflow**, puis **Run workflow** pour relancer tout de suite.
- Les crons GitHub `*/10` partent souvent avec 5 à 30 minutes de retard, et sautent parfois des passages quand GitHub est chargé. La santé en tient compte (tolérance sur les échéances de relance), mais un moniteur externe qui appelle `/api/cron/tick` rend la maintenance régulière.
- Si le tick s'arrête, `/api/health` répond 503 après 30 minutes (dès qu'une boutique est en ligne) : c'est le moniteur externe de l'étape 3 qui te prévient.

Réponses de `/api/health` :
   - **503, `status: "down"`** : l'application ne protège plus les paiements. Base de données injoignable, maintenance pas passée depuis plus de 30 minutes (ou jamais) alors qu'une boutique est en ligne (activée, Whop et Shopify connectés), checkout de secours actif, rafale de webhooks à signature invalide (3 ou plus en 1 h), tâche de maintenance en erreur, ou file du circuit de l'argent qui ne se vide plus (commandes payées absentes de Shopify depuis 30 min, remboursements non reportés depuis 30 min après le remboursement, événements Whop inachevés, alertes non délivrées, réconciliation bloquée). Le tableau `down` dit pourquoi.
   - **200, `status: "degraded"`** : tout tourne, mais des éléments abandonnés par l'automatisation (déjà signalés par une alerte) attendent un humain : synchro Shopify, offre, report de remboursement, événement Whop ou alerte abandonnés, tag « litige-whop » impossible à poser, suivi jamais transmis à Whop, envoi du suivi en échec répété, litiges à traiter dans Whop, paiements mis de côté, offres ajoutées à la commande d'origine dont le paiement Whop n'est pas enregistré sur la commande (solde « à payer »). Le tableau `needsAction` les liste ; on les règle depuis le Journal (« Relancer » ou « Traité »). Aussi « degraded » : des éléments en attente de leur prochain essai automatique (backoff normal après un échec, tableau `retrying`) ; ils ne comptent comme « down » qu'une fois leur échéance (`nextSyncAt` / `nextRefundMirrorAt`) dépassée de plus de 20 minutes.
   - **200, `status: "degraded"`** aussi : un service externe en difficulté sur la dernière heure (plus de 20 % d'erreurs sur au moins 10 appels, ou 95 % des appels plus lents que 8 s), un service en échec continu depuis 15 minutes (évalué par `/api/health` lui-même, même si la maintenance est en retard), ou une tâche de maintenance hors argent reportée faute de temps depuis plus de 6 h. Section `providers` : pour chaque service (Shopify, Whop, Meta, TikTok, Google Ads, GA4, BCE, Resend, Telegram, Mondial Relay), appels, erreurs, délais dépassés, taux d'erreur, p95 (ms), dernier succès, `degraded` et `failingSustained` ; `starvedJobs` liste les tâches reportées. Une tâche **d'argent** (paiements, commandes, remboursements, litiges) reportée depuis plus de 1 h rend la réponse **503 « down »** (`starvedMoneyJobs`), avec une alerte `tick.money_job_starved`.
   - **Sortie publique sans détail :** `/api/health` est public ; il ne donne que des noms de tâches et des codes (`tickErrors` = noms des tâches en erreur), jamais le texte d'une erreur ni le nom d'une boutique. Avec l'en-tête `Authorization: Bearer <CRON_SECRET>`, la réponse ajoute `details.tickErrors` (le message de chaque tâche en erreur, nettoyé des données personnelles).
   - **200, `status: "ok"`** : rien à faire.

   Champs : `ok` (faux seulement si `down`), `status`, `reasons` (`down`, `needsAction` puis `retrying`), `down`, `needsAction`, `retrying`, `db`, `liveStores`, `tickAgeMin`, `tickErrors`, `tickSkipped`, et les compteurs `unsyncedOver30min`, `offersUnsynced`, `offersStuck`, `refundsUnmirrored`, `webhooksUnprocessed`, `alertsUndelivered`, `webhookBadSignatures1h`, `fallbackActive`, `healingStale`, `reconcileStale`, `reconcileCatchingUp` (côté « down ») et `webhooksGaveUp`, `alertsGaveUp`, `refundsGaveUp`, `syncGaveUp`, `offersGaveUp`, `disputeTagsGaveUp`, `trackingGaveUp`, `trackingFailing`, `disputesNeedAction`, `reviewHolds`, `offersUnpaidBalance` (côté « needs action ») et `syncBackingOff`, `offersBackingOff`, `refundsBackingOff` (côté « retrying »). La réponse est mise en cache 10 s. La tuile « Maintenance automatique » du tableau de bord affiche la même chose, et une alerte `tick.stale` (au plus une toutes les 6 h) part dès qu'un webhook arrive ou qu'une page du tableau de bord s'ouvre alors que la maintenance est arrêtée depuis plus de 30 minutes.

**Services externes (Journal › Services externes) :** chaque appel à Shopify, Whop, aux régies publicitaires, à la BCE, à Resend / Telegram et à Mondial Relay est compté par tranche de 5 minutes (table `ProviderMetric` : appels, erreurs, délais dépassés, histogramme des temps de réponse, dernier succès, dernière erreur nettoyée des données personnelles). Écriture groupée après la réponse ou en fin de maintenance, jamais sur le chemin du paiement (un échec d'écriture est ignoré) ; conservation 14 jours. La carte du Journal affiche, par service, les appels sur 1 h / 24 h, le taux d'erreur, le p95 et la dernière erreur en clair ; une alerte `provider.degraded` (au plus une par service et par heure) part quand le taux d'erreur d'un service reste au-dessus de 20 % pendant 15 minutes.

**Maintenance sous contrainte de temps :** chaque tâche de la maintenance a sa tranche (8 s pour le circuit de l'argent, 5 s pour les autres) et les appels d'une tâche d'argent s'arrêtent à la fin de sa tranche (plus 4 s) : un Shopify lent ne peut consommer que le temps de ses propres tâches. Les tâches côté Whop (paiements manqués, offres en attente, remboursements, litiges) passent avant les relances Shopify, qui créent ensuite les commandes des paiements récupérés. Les boutiques sont parcourues à tour de rôle, et les tâches hors argent partent d'un point qui tourne à chaque passage ; une tâche reportée faute de temps est signalée (journal, alerte au plus toutes les 6 h, tuile « Maintenance automatique », `/api/health`) : après 1 h pour une tâche d'argent (`tick.money_job_starved`), 6 h pour les autres (`tick.job_starved`). La surveillance des services externes passe parmi les premières tâches (lecture de la base seulement), et l'envoi des preuves de litige (échéance fixée par la banque) passe juste après le suivi, avant les relances Shopify, avec une tranche réservée même quand le budget du passage est épuisé. Un appel Whop borne son délai au temps qui reste **au moment de l'appel** (pas à la création du client).

**Suivi des erreurs (facultatif, Sentry) :** avec `SENTRY_DSN` (DSN d'un projet Sentry, *Settings → Client Keys*), les erreurs inattendues d'une route API, les tâches de maintenance en échec et toute ligne de journal de niveau erreur portant l'erreur elle-même (`upsell.error`, `webhook.failed`, `*.deferred_failed`, `tick.follow_up_failed`…) sont envoyées à Sentry par son API HTTP (« envelope »), sans dépendance supplémentaire. Échantillonnage `SENTRY_SAMPLE_RATE` (défaut 1) et une même erreur au plus une fois par minute et par instance. Aucune donnée personnelle : seuls le type d'erreur, le message et la pile d'appels (e-mails, jetons, clés et numéros longs remplacés), la route ou la tâche, l'identifiant de requête et l'environnement partent — jamais un corps de requête, un client, une adresse ni un en-tête. Sans `SENTRY_DSN`, rien n'est envoyé.

**Plusieurs boutiques sur un même compte Whop :** c'est possible (chaque boutique a son propre produit Whop), mais les webhooks et les listes de Whop couvrent tout le compte. Chaque boutique reçoit donc aussi les paiements, remboursements et litiges des autres. Ils sont reconnus et ignorés sans alerte (une ligne d'information dans le journal). Chaque boutique enregistre sa propre copie d'un événement (clé : boutique + identifiant du webhook) : le même envoi reçu par une autre boutique du compte n'est jamais pris pour un doublon.

## Ajouter une boutique (environ 5 minutes)

Le dashboard te guide à chaque étape :

1. **Ajouter une boutique** : donne-lui un nom.
2. **Shopify** :
   - Dans le [Dev Dashboard Shopify](https://dev.shopify.com/dashboard), crée une app.
   - Colle l'App URL, la Redirect URL et les scopes affichés (avec les boutons « Copier »).
   - Publie la version (Release), puis choisis *Custom distribution* sur ta boutique.
   - Colle le domaine `.myshopify.com`, le Client ID et le Client secret, puis clique sur **Enregistrer et installer**.
   - Approuve dans Shopify. **Le script d'interception est installé automatiquement.**
3. **Whop** : colle ta clé API (sandbox en mode test). L'app **crée elle-même** le produit caché « Checkout » et le webhook : rien à configurer dans Whop.
4. **Livraison** : ajoute au moins un tarif (pays, prix, « offert dès … »).
5. **Design du checkout** : builder avec aperçu en direct, sauvegarde automatique.
6. **Vue d'ensemble → Mettre en ligne.**

Pour tester, ouvre **Interception → « Ouvrir la boutique en mode test »** (`?whopco_debug=1`). Les boutons interceptés sont entourés en vert et un badge confirme que le checkout est actif.

La boutique démarre en **mode test** : paiements Whop sandbox et commandes Shopify marquées `test`. Passe en production dans **Réglages**, puis reconnecte Whop avec ta clé de production.

## Fonctionnalités

- **Multi-boutiques** :
  - chaque boutique a sa propre app Shopify, son compte Whop, son design et ses réglages ;
  - un sélecteur de boutique est disponible dans la barre latérale.
- **Interception sans toucher au thème** :
  - ScriptTag installé et retiré automatiquement ;
  - des interrupteurs pour : bouton Paiement du panier, cart drawer, « Acheter maintenant », « Ajouter au panier → checkout direct » ;
  - sélecteurs CSS personnalisés et produits exclus ;
  - retour automatique au checkout Shopify en cas de problème ;
  - plan B : une ligne à coller dans `theme.liquid`.
- **Prix recalculés côté serveur** : les prix viennent de l'API Admin Shopify, jamais du navigateur.
- **Builder** :
  - sections fixes réordonnables : Contact, Livraison, Mode de livraison, Paiement ;
  - 14 blocs : options, annonce, texte, image, témoignage, note, badges, garantie, FAQ, arguments, logos de paiement, minuteur, stock bas, « Pourquoi nous » ;
  - style par bloc ;
  - glisser-déposer, masquer, dupliquer ;
  - aperçu **ordinateur / mobile** ;
  - police, arrondis, couleurs, logo, langue FR/EN ;
  - **sauvegarde automatique**.
- **Page de remerciement** : personnalisable (blocs au-dessus ou en dessous du récapitulatif).
- **Offres post-achat en 1 clic** : chaque offre acceptée a sa propre commande Shopify, liée à la première. Option (Shopify → « Offres post-achat », **désactivée par défaut**) : « Ajouter les offres à la commande d'origine » (un seul colis), seulement pendant une fenêtre après la commande (10 min par défaut), sur une commande non expédiée, sans blocage de traitement ni tag d'app fournisseur (DSers, AutoDS, Zendrop, CJ…), et seulement si Shopify augmente la commande exactement du montant payé (pas de taxe ajoutée). **Dropshipping** : si ton app transmet les commandes au fournisseur automatiquement, une offre ajoutée après la transmission ne serait jamais expédiée — laisse l'option désactivée ou garde une fenêtre plus courte que ce délai. Le paiement Whop de l'offre est enregistré une seule fois sur la commande (paiement manuel « Whop wc-offer-in-… ») et ses remboursements partent de ce paiement.
- **Livraison par pays**, **codes promo** (%, montant, livraison offerte, minimum, expiration, limite d'utilisation) et **options / order bumps** (frais ou vraie variante Shopify).
- **Commandes** :
  - statut du paiement et de la synchronisation Shopify ;
  - lien vers la commande ;
  - bouton **Re-synchroniser** si Shopify a échoué ;
  - **remboursement** depuis le dashboard, reporté automatiquement dans Shopify via le webhook.
- **Webhooks Whop** :
  - signature vérifiée (Standard Webhooks) et idempotence ;
  - verrou anti-doublon sur la création de commande ;
  - si le montant payé est inférieur au total, aucune commande n'est créée ;
  - litiges tagués `litige-whop` sur la commande Shopify.
- **Conformité UE**, en corrigeant les défauts relevés chez Crisp :
  - opt-in marketing **jamais pré-coché** ;
  - minuteur avec une **vraie date de fin** ;
  - stock bas lu dans **l'inventaire réel** ;
  - pas de faux bloc Trustpilot ;
  - pas de HTML libre (risque XSS) ;
  - URLs limitées à http(s).
- **Sécurité** :
  - secrets Shopify et Whop chiffrés (AES-256-GCM) ;
  - OAuth Shopify vérifié (HMAC + state) ;
  - URLs de retour limitées au domaine de la boutique.

### Round 10

- **Cumul des remises** : les remises quantité comptent comme une remise produit. Un code Shopify suit ses « Combinaisons » (`combinesWith` : produit, commande, livraison), un code de l'onglet Offres sa case « Cumulable avec les remises quantité », et les remises automatiques Shopify leurs propres règles. Quand deux remises ne se cumulent pas, la meilleure pour le client est gardée (comme Shopify) et le code écarté est signalé. Les codes Shopify « Achetez X, obtenez Y » sont appliqués (articles les moins chers offerts ou remisés, limite d'utilisations par commande). Limite d'utilisation totale d'un code Shopify : le compteur de Shopify (`asyncUsageCount`) ne compte probablement pas les commandes créées par l'API, et rien ne permet de l'incrémenter ; l'app compte donc le compteur Shopify **plus** ses propres utilisations payées. Si Shopify les compte aussi, le code s'épuise un peu avant sa vraie limite (« code épuisé » pour le client) — jamais au-delà.
- **Abonnements et cartes cadeaux** : un panier avec une ligne d'abonnement (`selling_plan`) ou une carte cadeau part entièrement vers le checkout Shopify (le script du storefront laisse passer, le serveur refuse aussi ; un « Acheter maintenant » d'abonnement est ajouté au panier avec son plan puis envoyé au checkout Shopify). L'utilisation d'une carte cadeau Shopify comme moyen de paiement n'est pas prise en charge.
- **Conversions des régies** : l'import Meta / TikTok / Google Ads récupère aussi les achats et leur valeur déclarés par la régie ; Analytics › Acquisition compare « ROAS plateforme » et « ROAS réel » (nos commandes) avec le taux de sur-attribution. Les clics Google (gclid, gbraid, wbraid) et Microsoft (msclkid) sont conservés ; les commandes payées issues de Google Ads sont envoyées en conversions hors ligne (`uploadClickConversions`, dédoublonnées par commande) si une action de conversion est renseignée.
- **Sinistres** : le client joint jusqu'à 3 photos (5 Mo max chacune, réduites dans le navigateur, type vérifié sur le contenu, stockées en base) ; un renvoi accepté peut créer une commande de remplacement à 0 € dans Shopify (étiquette `sinistre-<id>`) ; le client reçoit la décision par e-mail dans sa langue. Sur Vercel, le corps d'une requête est limité à 4,5 Mo : les photos réduites tiennent largement dans cette limite.
- **Tests A/B du checkout** (Analytics › Tests A/B) : paliers de remise, prix ou affichage d'une option, prix de la protection colis ; décision sur la marge par visiteur, « Promouvoir B » applique le réglage. Limite connue : le bras est attribué par visiteur (identifiant signé du navigateur), pas par personne ; un client qui revient sans lui (cookies effacés, autre appareil, navigation privée) peut tomber dans l'autre bras et voir un autre prix pour le même élément. Un même checkout reste toujours dans un seul bras : le client paie le prix affiché.
- **Fuseau horaire** (Réglages › Boutique) : jours et heures des analytics, du rapport quotidien, des alertes et de la carte jour × heure.

## Points à vérifier sur une vraie boutique

- **ScriptTags** : la documentation Shopify les réserve officiellement aux thèmes « vintage » pour les apps de l'App Store. Si ton thème ne charge pas le script (le badge debug n'apparaît pas), utilise le plan B dans l'onglet Interception : une ligne à coller dans `theme.liquid`.
- **Taxes** : l'app n'ajoute pas de lignes de taxe à la commande Shopify. La TVA est gérée côté Whop (mode « collects & remits ») ou incluse dans tes prix.
- **Codes promo Whop** : le formulaire Whop propose son propre champ de code promo. Un code Whop qui baisse le prix est détecté : la commande n'est pas créée et l'écart s'affiche dans Commandes.

## Développement

```bash
npm run dev          # http://localhost:3000
npm test             # tests unitaires (prix, webhook, OAuth, commande Shopify, layout, chiffrement)
npm run lint && npm run typecheck
```

- **Code principal** : `src/lib/` (`pricing.ts`, `shopify.ts`, `whop.ts`, `checkout.ts`, `layout.ts`).
- **Script de la boutique** : `public/loader.js`.
- **Checkout** : `src/components/checkout/`.
- **Builder** : `src/components/builder/`.
- **Dashboard** : `src/app/dashboard/`.

## Prochaines étapes (phases 2 et 3)

- **Phase 2** :
  - pixels Meta/TikTok + Conversions API ;
  - domaine de checkout personnalisé (CNAME) ;
  - Apple Pay / Google Pay express ;
  - relance des paniers abandonnés ;
  - analytics avancés et export CSV ;
  - sondage post-achat.
- **Phase 3** : abonnements, A/B tests, liens d'achat directs, upsell post-achat en 1 clic.
