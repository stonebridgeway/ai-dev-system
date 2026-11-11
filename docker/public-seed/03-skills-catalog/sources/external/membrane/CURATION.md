# Membrane connectors: what this seed keeps

The upstream repository (`membranedev/application-skills` at
`f484c8265e70ec910a57342389cca5c5de7d8167`, MIT) publishes 3,074 connectors,
one per application, and its README describes all of them. This seed carries
460: the connectors for tools a developer works with while building, testing,
shipping and running software, and the ones for talking to AI models.

## The rule

A connector stays when the application is part of software development or of
working with a model:

- code hosting, CI/CD, builds and releases;
- cloud, hosting, containers, infrastructure as code, databases and data
  infrastructure;
- monitoring, logs, error tracking, incidents and status pages;
- testing, code quality, application security, secrets and application
  authentication;
- API design, gateways, mocking and webhooks; feature flags; issue trackers
  built for software teams; developer documentation; design handoff;
- AI model APIs, LLM tooling, vector databases and ML platforms.

Everything else was removed: payments and finance, CRM and sales, marketing
and e-mail campaigns, e-commerce, HR and recruiting, scheduling, forms and
surveys, documents and e-signatures, general chat and productivity suites,
SMS, voice and video APIs, maps and data feeds, web scraping, no-code and
low-code builders, chatbot builders, consumer applications and games. A
connector whose own page describes a different product than its name (its
documentation link or entity list belongs to something else) was removed as
well.

The skill files that remain are unchanged upstream text, with one exception:
upstream's `confluent/SKILL.md` has 150 NUL bytes where its one-line
description should be (at the revision above and on upstream `main` as of
2026-10-11), and this seed drops them with the blank line after them. Every
other byte of that file is upstream's. To restore a removed
connector, take its `skills/<name>/` directory from the upstream revision above
or from this repository's history, then run `npm run docker:seed:verify -- --write`
in `ai-dev-mcp-server`.

## Kept connectors (460)

### Code hosting and version control (9)

`assembla`, `azure-devops`, `beanstalk`, `bitbucket`, `gist`, `gitea`, `github`, `gitlab`, `sourceforge`

### CI/CD, builds and releases (23)

`appcircle`, `appveyor`, `armoryio`, `bitrise`, `buddy`, `buildbuddy`, `circleci`, `cirrus-labs`, `cloudbees`, `codemagic`, `deploybot`, `deployhq`, `github-actions`, `harness`, `jenkins-x`, `makelog`, `octopus-deploy`, `semaphore`, `semaphoreci`, `teamcity`, `travis-ci`, `unity-cloud-build`, `xebialabs`

### Cloud, hosting, CDN and DNS (50)

`akamai`, `alibaba-cloud`, `amazon-ecs`, `amazon-eks`, `amazon-eventbridge`, `aws-s3`, `aws-well-architected`, `backblaze`, `belugacdn`, `bunnycdn`, `cloud-foundry`, `cloudflare`, `cloudflare-r2`, `cloudflare-workers`, `digital-ocean`, `dnsimple`, `fastly`, `filebase`, `flyio`, `gigalixir`, `google-cloud`, `heroku`, `ibm-cloud`, `jelastic`, `leaseweb`, `minio`, `mirantis`, `netlify`, `northflank`, `ns1`, `ovhcloud`, `paperspace`, `platform9`, `porter`, `rafay-systems`, `railway`, `rancher-labs`, `render`, `scaleway`, `serverless`, `shuttle`, `softlayer`, `stackery`, `upcloud`, `vercel`, `vmware`, `vultr`, `zeet`, `zeit`, `zoho-catalyst`

### Infrastructure as code and DevOps (22)

`ansible`, `bunnyshell`, `chef`, `chef-inspec`, `cloudcraft`, `cloudquery`, `ctoai`, `docker-hub`, `inedo-otter`, `jfrog`, `kosli`, `ploi`, `pulumi`, `puppet`, `red-hat`, `replicated`, `scalr`, `serveravatar`, `simplebackups`, `spacelift`, `terraform`, `turbot-pipes`

### Backend as a service (8)

`appwrite`, `firebase-admin-sdk`, `grafbase`, `hasura`, `nhost`, `postgrest`, `slash-graphql`, `supabase`

### Databases and data infrastructure (41)

`actian`, `airbyte`, `amazon-athena`, `amazon-elasticsearch`, `arangodb`, `astronomer`, `clickhouse`, `cockroachdb`, `confluent`, `couchbase`, `cubejs`, `databricks`, `dbt-cloud`, `dolthub`, `edgedb`, `elastic`, `fivetran`, `google-cloud-dataflow`, `harperdb`, `influxdb-cloud`, `kvdb`, `lakefs`, `macrometa`, `microsoft-azure-sql-database`, `neon`, `planetscale`, `prisma`, `questdb`, `realm`, `redis`, `redis-labs`, `rockset`, `snowflake`, `talend`, `terminus-app`, `tinybird`, `turso`, `upstash-redis`, `vectorizedio`, `xata`, `yugabyte`

### Search, realtime and networking infrastructure (15)

`ably`, `ably-realtime`, `algolia-search`, `appbaseio`, `dapr`, `envoy`, `fanout`, `haproxy`, `nginx`, `orama`, `pubnub`, `pusher`, `scaledrone`, `swiftype`, `typesense`

### Monitoring, logs, errors, incidents and status pages (69)

`alertops`, `appsignal`, `bearer`, `better-stack`, `blackfire`, `bugsnag`, `cisco-appdynamics`, `datadog`, `debugbear`, `dynatrace-api`, `elmahio`, `embrace`, `firehydrant`, `flare`, `gtmetrix`, `heartbeat`, `honeybadger`, `honeycombio`, `humio`, `hyperping`, `icinga`, `incidentio`, `instana`, `instatus`, `jaegertracing`, `kamonio`, `kibana`, `librato`, `lightstep`, `logdna`, `loggly`, `logit-io`, `logsnag`, `logstash`, `logz-io`, `lumigo`, `mackerel`, `metricfire`, `mezmo`, `new-relic`, `oh-dear`, `oneuptime`, `opsgenie`, `pagerduty`, `papertrail`, `pingdom`, `pulsetic`, `raygun`, `resurface`, `rollbar`, `scout-apm`, `sematext`, `sentry`, `signalfx`, `splunk`, `squadcast`, `stackify`, `stackstate`, `statuscake`, `statusio`, `statuspage`, `statuspage-io`, `statuspal`, `sumo-logic`, `tideways`, `updownio`, `uptime-robot`, `victorops`, `zabbix`

### Testing and QA (30)

`applitools`, `artilleryio`, `assertible`, `blazemeter`, `browserhub`, `browserless`, `browserstack`, `bugbug`, `ghost-inspector`, `headless-testing`, `kubeshop`, `lambdatest`, `lighthouse`, `mabl`, `mockaroo`, `pact-foundation`, `percy`, `practitest`, `rainforest-qa`, `saucelabs`, `selenium`, `smartbear`, `testimio`, `testmo`, `testmonitor`, `testrail`, `tonic`, `zephyr-essential-cloud`, `zephyr-scale`, `zephyr-squad-legacy`

### Code quality and coverage (6)

`codacy`, `code-climate`, `codescene`, `coveralls`, `sonarcloud`, `sonarqube`

### Application security and secrets (40)

`42crunch`, `acunetix`, `aikido-security`, `apisecai`, `bright-security`, `burp-suite`, `checkmarx`, `cloudflare-api-shield`, `code-dx`, `conjur`, `contrast-security`, `detectify`, `digicert`, `doppler`, `falcosecurity`, `fortify`, `infisical`, `mend`, `mozilla-observatory`, `nowsecure`, `open-policy-agent`, `pangea`, `plextrac`, `secure-code-warrior`, `security-journey`, `semgrep`, `shiftleft`, `snyk`, `sonatype`, `sslmate-cert-spotter-api`, `stackhawk`, `strongdm`, `tinfoil-security`, `traceable`, `ubiq-security`, `veracode`, `waratek`, `whitehat-security`, `whitesource`, `zerossl`

### Authentication and identity for applications (19)

`amazon-cognito`, `auth0`, `authlete`, `clerk`, `cloudentity`, `cognito`, `curity`, `forgerock`, `frontegg`, `fusionauth`, `hankoio`, `keycloak`, `loginid`, `microsoft-entra-id`, `okta`, `ory`, `propelauth`, `workos`, `zitadel`

### API design, gateways, mocking and webhooks (26)

`akana-by-perforce`, `amazon-api-gateway`, `apicurio-registry`, `apimetrics`, `azure-api-management`, `google-cloud-api-gateway`, `graphql-editor`, `hookdeck`, `ibm-api-connect`, `insomnia`, `kong`, `microcks`, `moesif`, `openapi-generator`, `postman`, `rapidapi`, `rapidoc`, `speakeasy`, `stepzen`, `svix`, `swaggerhub`, `treblle`, `tyk`, `webhook`, `wso2`, `zuplo`

### Feature flags and experimentation (6)

`flagsmith`, `growth-book`, `launchdarkly`, `posthog`, `unlaunch`, `unleash`

### Issue and bug trackers for software teams (14)

`backlog`, `bugherd`, `bugzilla`, `fogbugz`, `gleap`, `jetbrains-youtrack`, `jira`, `linear`, `shortcut`, `sifter`, `yodiz`, `zenhub`, `zoho-bugtracker`, `zoho-sprints`

### Developer documentation (3)

`archbee`, `gitbook`, `readme-com`

### Design handoff (1)

`figma`

### Other developer tools (25)

`amplication`, `chocolatey`, `coder`, `codesee`, `connectall`, `dart`, `deno-a-secure-runtime-for-javascript-and-typescript`, `faros`, `font-awesome`, `four-js-development-tools`, `gitpod`, `greptile`, `jetbrains-marketplace`, `linearb`, `localstack`, `ngrok`, `npm`, `opslevel`, `scopemaster`, `sourcegraph`, `structurizr`, `termius`, `vagrant`, `warp`, `waydev`

### AI models, LLM tooling, vector databases and ML platforms (53)

`ai21-labs`, `aleph-alpha`, `algorithmia`, `amazon-sagemaker`, `anthropic`, `azure-openai-service`, `bigml`, `cnvrgio`, `cody`, `cohere`, `comet-ml`, `cursor`, `datarobot`, `deepseek`, `eden-ai`, `exa`, `flowiseai`, `google-cloud-ai-platform`, `google-gemini`, `google-vertex-ai`, `gpt-trainer`, `hastyai`, `hugging-face`, `kern-ai`, `kodagpt`, `lighton`, `llama-ai`, `llamaindex`, `metatextai-inference-api`, `mindsdb`, `mlflow`, `modelscope`, `mosaicml`, `nannyml`, `nlp-cloud`, `one-ai`, `openai`, `openrouter`, `perplexity`, `pinecone`, `qdrant`, `relevance-ai`, `replicate`, `roboflow`, `scale-ai`, `stability-ai`, `tabnine`, `tavily`, `truss`, `unstructured`, `vectara`, `watsonx-ai`, `wb`
