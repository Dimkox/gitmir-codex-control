# gcloud-doctor: эксплуатация и ремонт

Необязательный модуль GitMir для Windows, macOS и Linux. Исполняемый диагностический
код находится внутри навыка и устанавливается вместе с ним; отдельный облачный
сервер, npm-пакеты и Google Cloud account для самого GitMir не требуются.

## Запуск

Из корня GitMir одинаково в PowerShell, cmd, bash и zsh:

```text
npm run doctor:gcloud
npm run doctor:gcloud -- --json
npm run doctor:gcloud -- --project example-project --min-version 584.0.0
npm run doctor:gcloud -- --require-local-adc --strict
```

`example-project` и 584.0.0 — примеры параметров проверки, не настройки по умолчанию.
Для текущей установленной копии плагина вне репозитория запускайте `node` с полным
путём к `scripts/doctor.mjs` внутри установленного навыка. В Codex вызовите
`$gcloud-doctor`; в dashboard навык доступен через обычный список Skills.
Ни один диагностический запуск не обновляет SDK и не исправляет реестр.

Параметры: `--json`, `--project ID`, `--min-version X.Y.Z`, `--gcloud ABSOLUTE_PATH`,
`--require-local-adc`, `--strict`, `--timeout-ms N` (50–120000 на одну проверку),
`--help`. Неизвестные параметры, включая `--fix`, отклоняются. Требование GitMir —
Node.js >=22.18.0. Для самой диагностики установка зависимостей не нужна.

## Что проверяется

| ID | Проверка | Чего результат не доказывает |
|---|---|---|
| PLATFORM | Windows, macOS или Linux, архитектура текущего процесса | Нативная архитектура всех SDK-компонентов |
| SDK_PATH | Доступный launcher, реальные дубликаты в PATH | Владение установкой конкретным пакетным менеджером |
| SDK_VERSION | Фактическая версия и заданный минимум | Что установлена самая свежая версия |
| SDK_RUNTIME | Каталог SDK, путь и версия используемого Python | Совместимость всех сторонних Python-пакетов |
| PROJECT | Текущий проект, region/zone, совпадение с ожидаемым | Существование проекта, доступ и биллинг |
| CONFIGURATION | Активная именованная конфигурация | Пригодность для каждого запуска приложения |
| CLI_CREDENTIALS | Активная локальная запись CLI без имени аккаунта | Валидность токена и успешная авторизация |
| CLI_AUTH_OVERRIDES | Наличие impersonation/credential/token overrides | Какая identity реально пройдёт запрос |
| ADC_LOCAL | Доступный файл-кандидат ADC, только stat/access | Содержимое, JSON-валидность, scopes, IAM |
| ADC_CUSTOM_CONFIG | Нестандартный CLOUDSDK_CONFIG | Что конкретная клиентская библиотека использует его |
| CLOUD_ACCESS | Явное `not-tested` | Никаких сетевых гарантий |

Сначала учитывается `GOOGLE_APPLICATION_CREDENTIALS`. При его отсутствии проверяется
стандартный пользовательский путь: `%APPDATA%\gcloud\application_default_credentials.json`
в Windows и `$HOME/.config/gcloud/application_default_credentials.json` в macOS/Linux.[1]
Некорректный явный override — ошибка, а не повод незаметно выбрать другой файл.
Отсутствие стандартного файла — предупреждение: workload может использовать metadata
server. `--require-local-adc` повышает только это отсутствие до ошибки.
`CLOUDSDK_CONFIG` диагностируется отдельно; для нестандартного хранения рекомендуем
явный `GOOGLE_APPLICATION_CREDENTIALS` в окружении приложения после проверки источника.

Установленный SDK запускается пятью локальными командами: `version`, `info`,
`config list`, `config configurations list`, `auth list` с ограниченными JSON-полями.[2][3][4]
Вывод аккаунтов и сырые ошибки в отчёт не копируются. Файлы credentials, `.env` и
ключи не читаются. SDK может сам создавать локальные журналы; это не файловая
песочница. Запросы Google APIs, metadata probe и сетевой тест `info --run-diagnostics`
не запускаются. Подавляются update check, usage reporting и HTTP logging дочерних
процессов, но это не замена сетевой изоляции или аудиту самого SDK.

## Результат для человека и CI

JSON имеет `schemaVersion: 1`, список checks и итоговые счётчики. Коды завершения:
0 — нет ошибок; 1 — ошибки, либо предупреждения с `--strict`; 2 — неверные аргументы
или внутренняя ошибка. `pass` означает только конкретную локальную проверку.
`cloudAccess: not-tested` сохраняется и при полностью зелёном отчёте.

Домашний каталог в путях заменяется на `$HOME`. Project ID, имена конфигураций и
другие пути остаются: перед публичной публикацией отчёт нужно просмотреть.
Автоматической отправки отчётов, создания задач и записи файлов у CLI нет.
Для задач используйте `$gcloud-doctor` и существующие `$task-planner`/`$task-runner`:
у задачи должны быть воспроизведение, разрешённая область ремонта и `## Verify`.

## Выбор процедуры обслуживания

Сначала установите источник именно выбранного SDK. Наличие `brew`, `apt` или
`winget` на машине само по себе не устанавливает владельца пакета. Проверьте путь
SDK и список установленного пакета штатным менеджером. Несколько установок —
сначала устранение неоднозначности, затем обновление только выбранной копии.

| Установка | Процедура после явного разрешения |
|---|---|
| SDK installer / распакованный архив | `gcloud components update --quiet` |
| Windows SDK со встроенным Python | Сначала отдельная копия Python; процедура ниже |
| macOS Homebrew cask `gcloud-cli` | `brew upgrade --cask gcloud-cli`, только если владение подтверждено |
| Linux APT, пакет `google-cloud-cli` | `sudo apt-get update`, затем `sudo apt-get install --only-upgrade google-cloud-cli` |
| Linux YUM, пакет `google-cloud-cli` | `sudo yum update google-cloud-cli` |
| Иной менеджер / контейнер / управляемый образ | Его штатная процедура или пересборка образа, без смены канала установки |

При установке через APT/YUM менеджер компонентов SDK отключён; не пытайтесь включать
его правкой внутренних файлов.[5] Homebrew cask имеет собственную процедуру
обновления; сначала подтвердите актуальное имя установленного cask.[6]
Конкретную целевую версию SDK можно задать `--version=X.Y.Z` только после проверки
её доступности и явного согласования; это может быть и downgrade.[7]
Фиксированной обязательной версии у gcloud-doctor нет.

## Windows: встроенный Python и non-interactive update

Ошибка `Cannot use bundled Python installation ... in non-interactive mode`
указывает на необходимость отдельного интерпретатора. Google CLI предлагает
`gcloud components copy-bundled-python`; переменная `CLOUDSDK_PYTHON` выбирает Python.[8]
Не заменяйте системный Python и не отключайте защиту ОС ради обновления.

Следующая функция — ручной сценарий обслуживания, не часть автоматической
диагностики. Выполнять вне каталога SDK, от той же учётной записи; для all-users
установки нужны права администратора. Без `-Version` запрашивается актуальная
доступная версия; указанная версия может понизить SDK. Сначала согласуйте операцию.

```powershell
function Update-GitMirGcloud {
    param([ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
    $ErrorActionPreference = 'Stop'
    $oldPython = $env:CLOUDSDK_PYTHON
    try {
        $copy = gcloud components copy-bundled-python
        if ($LASTEXITCODE -ne 0) { throw 'Bundled Python copy failed.' }
        $env:CLOUDSDK_PYTHON = ([string]$copy).Trim().Trim('"')
        if (-not (Test-Path -LiteralPath $env:CLOUDSDK_PYTHON -PathType Leaf)) {
            throw 'Copied Python executable was not found.'
        }
        $command = '/d /c gcloud components update --quiet'
        if ($Version) { $command += " --version=$Version" }
        $process = Start-Process -FilePath $env:ComSpec -ArgumentList $command -NoNewWindow -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "SDK updater failed: $($process.ExitCode)" }
    }
    finally { $env:CLOUDSDK_PYTHON = $oldPython }
    $json = gcloud version --format=json
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the installed SDK.' }
    $actual = ($json | ConvertFrom-Json -ErrorAction Stop).'Google Cloud SDK'
    if ($Version -and $actual -ne $Version) { throw "Expected $Version, got $actual." }
    Write-Output "Installed Google Cloud SDK: $actual"
}
```

Вызов функции сам по себе не встроен в навык: агент выполняет его только по
разрешению пользователя. Временная копия Python может остаться после процедуры;
не удаляйте её до завершения всех процессов обновления. Нет гарантии транзакционного
отката компонентов; downgrade к сохранённой версии — отдельная согласуемая операция.

## Windows: Unknown в WinGet — отдельная проблема

`Unknown` — неизвестная установленная версия; число в столбце available не доказывает
наличие этой версии на диске. Исправление `DisplayVersion` — изменение metadata в
существующей uninstall-записи, не обновление SDK и не pin.[9][10]

Порядок: прочитать реальную версию через `gcloud version --format=json`; найти
uninstall-запись в HKCU/HKLM с учётом 32/64-разрядного представления; сопоставить её
с выбранным SDK; экспортировать именно эту запись через `reg export`; записать
проверенную версию как `REG_SZ`; перечитать запись и `winget list --id Google.CloudSDK --exact`.
При нескольких записях, несовпадающих путях или неизвестном владельце остановиться.
Не подменять 583.0.0 числом 584.0.0. Для отката вернуть только предыдущий параметр
или импортировать проверенный экспорт этой записи, а не чужой снимок реестра.

Исторический кейс в GitMir: `docs/windows/gcloud-winget-version-repair/README.md` и
`Update-GCloudAndRepairWinget.ps1`. Он жёстко ориентирован на 584.0.0, а успешный
end-to-end запуск на исходном компьютере не подтверждён. Не запускать его как
универсальный ремонт и не переносить операции реестра на macOS/Linux.

## Ограничения и проверка

Поддерживаются Windows, macOS и Linux с Node >=22.18.0; WSL проверяется как Linux,
а не как Windows-хост. Intel/ARM не зашиты в код; архитектура берётся у процесса.
Для Windows `.cmd/.bat` вызываются через `cmd.exe /d /s /v:off /c` с отдельным
quoting; executable paths с `%`, `!`, кавычками или shell-метасимволами отклоняются.[11]
Пустые и относительные элементы PATH намеренно не используются. Дубли через symlink
схлопываются. Shell alias/function не виден процессу Node: укажите `--gcloud`.

Таймаут ограничивает ожидание отдельной проверки. На Windows завершение cmd-родителя
не гарантирует остановку всех порождённых им процессов; CLI не является supervisor.
При сбое не публикуйте сырой stderr, полный `gcloud info` или credential JSON.
Авторизация, SDK updates и запись реестра не входят в автоматические тесты.

```text
npm run test:gcloud-doctor
```

Тесты используют фиктивный SDK и временные файлы без облачного аккаунта. Проверяются
аргументы, платформенные пути, реальный запуск fixture-процессов, ошибки, несколько
установок, минимум версии, несовпадение проекта и отсутствие секретов в выводе.
Матрица GitHub Actions: Windows/macOS/Linux, Node 22.18.0 и 24.x. Наличие workflow
не означает успешного выполнения: проверяйте статус конкретного PR/commit.
PowerShell-сценарий выше и ремонт WinGet требуют отдельного Windows acceptance test.

## Официальные источники

1. [ADC: порядок поиска, платформенные пути и отличие от CLI credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials)
2. [gcloud info](https://docs.cloud.google.com/sdk/gcloud/reference/info)
3. [gcloud config list](https://docs.cloud.google.com/sdk/gcloud/reference/config/list)
4. [gcloud auth list](https://docs.cloud.google.com/sdk/gcloud/reference/auth/list)
5. [Управление компонентами и пакетные менеджеры](https://docs.cloud.google.com/sdk/docs/components)
6. [Homebrew: gcloud-cli](https://formulae.brew.sh/cask/gcloud-cli)
7. [gcloud components update](https://docs.cloud.google.com/sdk/gcloud/reference/components/update)
8. [CLOUDSDK_PYTHON и запуск SDK](https://docs.cloud.google.com/sdk/gcloud/reference/topic/startup)
9. [WinGet upgrade](https://learn.microsoft.com/windows/package-manager/winget/upgrade)
10. [Windows Installer: uninstall registry key / DisplayVersion](https://learn.microsoft.com/windows/win32/msi/uninstall-registry-key)
11. [Node.js: запуск .cmd/.bat в Windows](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
