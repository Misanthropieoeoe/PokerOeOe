# Poker Texas Hold'em

Texas Hold'em No Limit jouable dans le navigateur, en solo contre 3 à 5 bots.
Jetons fictifs uniquement (1 000 au départ), aucun argent réel.

## Lancer le jeu

Ouvrez `index.html` dans un navigateur (un double-clic suffit) : aucune dépendance, aucun serveur.

- `tests.html` : tests de l'évaluateur de mains et des side pots.
- `index.html?vitesse=rapide` : raccourcit tous les délais.
- Raccourcis clavier : F = se coucher, C = checker/suivre, R = relancer, Entrée = main suivante.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `js/deck.js` | Cartes et paquet mélangé |
| `js/handEvaluator.js` | Évaluation des mains, kickers, égalités |
| `js/game.js` | Moteur : blinds, enchères, side pots, abattage, éliminations |
| `js/bot.js` | Bots (facile, moyen, difficile) |
| `js/ui.js` | Interface et déroulement de la partie |
| `style.css` | Table, cartes en CSS, mise en page responsive |

Les blinds augmentent toutes les 10 mains. La partie s'arrête quand il ne reste qu'un joueur ou quand vous n'avez plus de jetons.
