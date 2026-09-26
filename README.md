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
