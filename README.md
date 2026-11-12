# Poker Texas Hold'em

Texas Hold'em No Limit jouable dans le navigateur : en solo contre des bots, ou en ligne entre amis.
Jetons fictifs uniquement (1 000 au départ), aucun argent réel.

## Jouer

- **Solo** : ouvrez `index.html` (un double-clic suffit), choisissez 3 à 5 bots et une difficulté. Fonctionne hors ligne.
- **En ligne** : un joueur choisit « Créer une table » et reçoit un code (ex. `K7PQ2`) et un lien d'invitation.
  Les autres choisissent « Rejoindre » et entrent le code (ou ouvrent le lien). L'hôte ajoute des bots s'il manque du monde
  (2 à 6 joueurs) puis lance la partie.

Le mode en ligne est le plus simple à utiliser depuis la version publiée avec GitHub Pages
(Settings → Pages → branche `main`) : le lien d'invitation est alors directement partageable.

## Comment fonctionne le multijoueur

- Le navigateur de l'hôte fait tourner la partie (mélange, distribution, side pots).
  Chaque joueur reçoit uniquement ses propres cartes ; celles des autres ne sont envoyées qu'à l'abattage.
- Les navigateurs se connectent directement entre eux (WebRTC) grâce à [PeerJS](https://peerjs.com),
  inclus dans `js/vendor/` (licence MIT). Le serveur public gratuit de PeerJS sert uniquement à les mettre en relation :
  une connexion Internet est donc nécessaire.
- 40 secondes par tour : passé ce délai, le joueur checke ou se couche automatiquement.
- Un joueur qui perd la connexion (ou recharge sa page) retrouve sa place en rejoignant avec le même code ;
  en attendant, il checke ou se couche automatiquement.
- L'hôte doit garder la page ouverte pendant la partie.
- Limites : certains réseaux très restrictifs (entreprise, certains réseaux mobiles) bloquent les connexions directes.

## Autres pages et options

- `tests.html` : tests de l'évaluateur de mains et des side pots.
- `index.html?vitesse=rapide` : raccourcit tous les délais.
- `?peerhost=…&peerport=…&peerpath=/` : utiliser votre propre serveur PeerJS au lieu du serveur public.
- Raccourcis clavier : F = se coucher, C = checker/suivre, R = relancer, Entrée = main suivante.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `js/deck.js` | Cartes et paquet mélangé |
| `js/handEvaluator.js` | Évaluation des mains, kickers, égalités |
| `js/game.js` | Moteur : blinds, enchères, side pots, abattage, éliminations, vue par joueur |
| `js/bot.js` | Bots (facile, moyen, difficile) |
| `js/session.js` | Déroulement d'une partie (solo et hôte) : tours, délais, déconnexions |
| `js/net.js` | Réseau (PeerJS / WebRTC) : création de table, connexion des invités |
| `js/ui.js` | Interface : accueil, salle d'attente, table, fin de partie |
| `style.css` | Table, cartes en CSS, mise en page responsive |

Les blinds augmentent toutes les 10 mains. La partie s'arrête quand il ne reste qu'un joueur,
ou quand plus aucun joueur humain n'a de jetons.
