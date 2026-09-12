# 20. Недостающие паки правил

Пункт [3.19 плана](PLAN.md), позиция C-8 в [gap-анализе](ECC-GAP-ANALYSIS.md).

## Идея из ECC

В ECC каталог `rules/` покрывает четырнадцать языков и фреймворков, которых у нас не было:
Vue, Kotlin, Swift, PHP, C#, C++, Dart, Ruby, Perl, Angular, Nuxt, ArkTS, F#, React Native,
плюс `python/fastapi` и `web/{performance,design-quality}`. Формат у нас свой — запись в
`RULE_PACKS` с `paths` и `stacks`, — поэтому переносится не текст, а покрытие.

## Что появилось в коде

| Файл | Роль |
| --- | --- |
| `ai-dev-mcp-server/src/core/rules-catalog.mjs` | Одиннадцать новых паков; вычитание `web` для React Native в `packsForStack` |
| `ai-dev-mcp-server/src/core/project-detection.mjs` | Метки стека, по которым новые паки выбираются: Nuxt, Angular, Kotlin, Swift, C#/.NET, C/C++, Ruby, Rails, Laravel, Symfony |

Тесты: `src/core/rules-library.test.mjs` — выбор паков по стеку, новое вычитание и проверка,
что у каждого пака есть метка, которую детектор действительно умеет выдавать;
`src/core/project-detection.test.mjs` — девять деревьев с корневыми файлами, по которым
метки и определяются.

Паков стало девятнадцать: к `typescript`, `react`, `web`, `python`, `golang`, `rust`, `java`,
`docker` добавились `vue`, `angular`, `react-native`, `fastapi`, `kotlin`, `swift`, `dart`,
`csharp`, `cpp`, `php`, `ruby`.

## Как паки выбираются

`packsForStack` складывает паки по меткам стека: у Next.js + TypeScript выходит
`typescript`, `react`, `web`. Единственное вычитание добавлено здесь: React Native делит с
браузером библиотеку, но не платформу, поэтому проект с меткой `React Native/Expo` не
получает `web` — там нет ни DOM, ни CSS, ни Core Web Vitals, о которых этот пак говорит.
Универсальное приложение, которое собирается ещё и для браузера (есть `Next.js` или `Vite`),
`web` сохраняет.

Метка должна откуда-то браться, иначе пак — мёртвый груз. Детектор читает корневые файлы:
`nuxt.config.*` и зависимость `nuxt`, `angular.json` и `@angular/core`, `build.gradle.kts` →
Kotlin (вместе с уже существующим Java/JVM), `Package.swift` → Swift, `Gemfile`/`Rakefile`/
`.ruby-version` → Ruby, а `rails` в `Gemfile` или `config/application.rb` → Rails, `artisan`
или `laravel/framework` в `composer.json` → Laravel, `symfony/framework-bundle` → Symfony,
`CMakeLists.txt`/`meson.build`/`configure.ac`/`conanfile.txt`/`vcpkg.json` → C/C++.

С .NET сложнее: у каждого репозитория есть `.csproj` или `.sln`, но названы они по продукту,
а детектор проверяет пути, а не перечисляет каталог. Поэтому метка ставится по пяти
общепринятым корневым файлам с фиксированными именами: `global.json`,
`Directory.Build.props`, `NuGet.config`, `nuget.config`, `.config/dotnet-tools.json`. Тест на
это есть; репозиторий без них останется без пака, пока детектор не научится читать каталог.

## Про `web/{performance,design-quality}`

Их в плане числят недостающими, но это не так: пак `web` уже несёт оба раздела — «Design
quality (anti-template policy)» и «Performance budgets» с бюджетами Core Web Vitals и
размеров бандла. Отдельные паки были бы дублем, поэтому их нет.

## Чего здесь нет

Не написаны паки `perl`, `arkts` и `fsharp`. Причина одна и та же: у детектора нет для них
метки, а правила пришлось бы писать по общим представлениям, не сверив их ни с одним живым
проектом. Пак, который никто не выберет и никто не проверил, — это не покрытие, а строки.
Записано отдельным долгом в [DEBTS.md](DEBTS.md).
