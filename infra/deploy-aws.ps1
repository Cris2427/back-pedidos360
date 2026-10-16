
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Region        = 'us-east-1',
    [string]$ApiId         = '5hnna48kv8',
    [string]$Prefijo       = 'pedidos360',
    [string]$CatalogTable  = 'Pedidos360-Catalog',
    [string]$OrdersTable   = 'Pedidos360-Orders',
    [string]$TenantId      = '20d60927-bff9-498f-8c5b-94db0ccba634',
    # las dos formas del claim aud: los tokens v2 lo mandan como el client id
    # pelado y los v1 con el api:// adelante
    # el authorizer compara literal, asi que aceptamos las dos
    [string[]]$Audiences   = @(
        '4af5ea55-a655-4bcb-b24c-9e315b1ee75c',
        'api://4af5ea55-a655-4bcb-b24c-9e315b1ee75c'
    ),
    [string]$AllowedOrigin = 'http://localhost:5173',
    # el rol con el que corren las lambdas, en aws academy es LabRole
    # necesita permisos basicos de lambda y acceso a las dos tablas
    [string]$RoleName      = 'LabRole',
    # nodejs20.x quedo obsoleto en abril de 2026 y la consola ya no lo ofrece
    [string]$Runtime       = 'nodejs24.x'
)

$ErrorActionPreference = 'Stop'

# todos los nombres de la mensajeria salen de este archivo
$Mensajeria = Get-Content (Join-Path $PSScriptRoot 'mensajeria.json') -Raw -Encoding UTF8 | ConvertFrom-Json

# las 10 lambdas, una por metodo y ruta
# el scope es el mismo que revisa cada lambda: el gateway lo exige antes
# de invocarla, asi un token sin ese permiso ni siquiera la despierta
$Endpoints = @(
    @{ Nombre = 'catalog-get';       Handler = 'handlers/catalog-get.handler';        Ruta = 'GET /api/catalog'; Scope = 'catalog.read' }
    @{ Nombre = 'catalog-post';      Handler = 'handlers/catalog-post.handler';       Ruta = 'POST /api/catalog'; Scope = 'catalog.write' }
    @{ Nombre = 'catalog-put';       Handler = 'handlers/catalog-put.handler';        Ruta = 'PUT /api/catalog/{id}'; Scope = 'catalog.write' }
    @{ Nombre = 'catalog-stock-put'; Handler = 'handlers/catalog-stock-put.handler';  Ruta = 'PUT /api/catalog/{id}/stock'; Scope = 'catalog.write' }
    @{ Nombre = 'catalog-delete';    Handler = 'handlers/catalog-delete.handler';     Ruta = 'DELETE /api/catalog/{id}'; Scope = 'catalog.write' }
    @{ Nombre = 'orders-get';        Handler = 'handlers/orders-get.handler';         Ruta = 'GET /api/orders'; Scope = 'orders.read' }
    @{ Nombre = 'orders-post';       Handler = 'handlers/orders-post.handler';        Ruta = 'POST /api/orders'; Scope = 'orders.write' }
    @{ Nombre = 'orders-put';        Handler = 'handlers/orders-put.handler';         Ruta = 'PUT /api/orders/{id}'; Scope = 'orders.write' }
    @{ Nombre = 'orders-status';     Handler = 'handlers/orders-status-patch.handler'; Ruta = 'PATCH /api/orders/{id}/status'; Scope = 'orders.write' }
    @{ Nombre = 'orders-delete';     Handler = 'handlers/orders-delete.handler';      Ruta = 'DELETE /api/orders/{id}'; Scope = 'orders.write' }
)

function Write-Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Skip($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# el aws cli no soporta el BOM al inicio de un archivo de parametros, y
# Set-Content -Encoding utf8 siempre lo agrega, por eso usamos WriteAllText
function Write-JsonFile {
    param([string]$Name, $Value)
    $path = Join-Path $env:TEMP $Name
    [System.IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Compress -Depth 10))
    return $path
}

function Write-TextFile {
    param([string]$Name, [string]$Value)
    $path = Join-Path $env:TEMP $Name
    [System.IO.File]::WriteAllText($path, $Value)
    return $path
}

# aws.exe no lanza excepciones cuando falla, hay que mirar $LASTEXITCODE
# por eso este helper y no un try/catch
function Test-AwsSuccess {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $Command *> $null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $previous
    return $ok
}

# revisamos que este todo antes de empezar
Write-Step 'Comprobando AWS CLI y credenciales'
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'No se encontró el comando `aws`. Instala AWS CLI v2 y vuelve a intentar.'
}
$AccountId = aws sts get-caller-identity --query Account --output text
if (-not $AccountId) { throw 'No hay credenciales activas o caducaron. Recárgalas y reintenta.' }
Write-Ok "Cuenta AWS: $AccountId · Región: $Region · API: $ApiId"

$RoleArn   = "arn:aws:iam::${AccountId}:role/$RoleName"
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ZipPath   = Join-Path $env:TEMP 'pedidos360-api.zip'

# el codigo puede estar en la raiz (si el backend tiene su propio repo) o
# bajo backend/pedidos360-api (si esta todo junto)
# probamos los dos para que mover las carpetas no rompa el despliegue
$SourceDir = @($RepoRoot, (Join-Path $RepoRoot 'backend/pedidos360-api')) |
    Where-Object { Test-Path (Join-Path $_ 'handlers') } |
    Select-Object -First 1

if (-not $SourceDir) {
    throw "No se encontro la carpeta handlers/ ni en $RepoRoot ni en $RepoRootackend\pedidos360-api."
}

# tablas
Write-Step 'Tablas de DynamoDB'
foreach ($table in @($CatalogTable, $OrdersTable, $Mensajeria.tablaNotificaciones)) {
    if (Test-AwsSuccess { aws dynamodb describe-table --table-name $table --region $Region }) {
        Write-Skip "ya existe: $table"
        continue
    }
    if ($PSCmdlet.ShouldProcess($table, 'crear tabla')) {
        aws dynamodb create-table `
            --table-name $table `
            --attribute-definitions AttributeName=id,AttributeType=S `
            --key-schema AttributeName=id,KeyType=HASH `
            --billing-mode PAY_PER_REQUEST `
            --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "No se pudo crear la tabla $table." }
        aws dynamodb wait table-exists --table-name $table --region $Region | Out-Null
        Write-Ok "creada:   $table"
    }
}

# productos iniciales, solo si la tabla esta vacia
Write-Step 'Catálogo inicial'
$cuenta = 0
if (Test-AwsSuccess { aws dynamodb describe-table --table-name $CatalogTable --region $Region }) {
    $cuenta = aws dynamodb scan --table-name $CatalogTable --select COUNT --query 'Count' --output text --region $Region
}
if ([int]$cuenta -gt 0) {
    Write-Skip "la tabla ya tiene $cuenta productos, no se siembra"
} elseif ($PSCmdlet.ShouldProcess($CatalogTable, 'sembrar 3 productos')) {
    $semilla = @(
        @{ id = @{ S = 'p-001' }; nombre = @{ S = 'Notebook 14"' }; precio = @{ N = '499990' }; stock = @{ N = '8' } },
        @{ id = @{ S = 'p-002' }; nombre = @{ S = 'Mouse inalámbrico' }; precio = @{ N = '14990' }; stock = @{ N = '40' } },
        @{ id = @{ S = 'p-003' }; nombre = @{ S = 'Teclado mecánico' }; precio = @{ N = '59990' }; stock = @{ N = '12' } }
    )
    foreach ($item in $semilla) {
        $file = Write-JsonFile "pedidos360-item-$($item.id.S).json" $item
        aws dynamodb put-item `
            --table-name $CatalogTable `
            --item "file://$file" `
            --condition-expression 'attribute_not_exists(id)' `
            --region $Region 2>$null | Out-Null
    }
    Write-Ok 'sembrados 3 productos'
}

# un solo zip para las 10 funciones, cada una apunta a un handler distinto
# adentro, asi el codigo de lib/ no se copia diez veces
Write-Step 'Empaquetando el código'
foreach ($carpeta in @('handlers', 'consumers', 'lib')) {
    if (-not (Test-Path (Join-Path $SourceDir $carpeta))) {
        throw "No se encontró la carpeta $carpeta en $SourceDir"
    }
}
$fuentes = @('handlers', 'consumers', 'lib') | ForEach-Object { Join-Path $SourceDir $_ }
# -Force pisa el zip anterior
# no usamos Remove-Item porque respeta -WhatIf y Compress-Archive no, asi que
# en el ensayo quedaba el archivo viejo y fallaba
Compress-Archive -Path $fuentes -DestinationPath $ZipPath -Force
Write-Ok "Zip listo: $ZipPath"

# las funciones
Write-Step 'Funciones Lambda (una por método y ruta)'
# pedidos publica los eventos, asi que las de la api tambien reciben el topic
$TopicArn = "arn:aws:sns:${Region}:${AccountId}:$($Mensajeria.topic)"
$envApi = Write-JsonFile 'p360-env-api.json' @{
    Variables = @{
        ALLOWED_ORIGIN       = $AllowedOrigin
        CATALOG_TABLE        = $CatalogTable
        ORDERS_TABLE         = $OrdersTable
        NOTIFICACIONES_TABLE = $Mensajeria.tablaNotificaciones
        TOPIC_ARN            = $TopicArn
        ATRIBUTO_FILTRO      = $Mensajeria.atributoFiltro
    }
}
$envVars = "file://$envApi"

foreach ($ep in $Endpoints) {
    $fn = "$Prefijo-$($ep.Nombre)"
    $existe = Test-AwsSuccess { aws lambda get-function --function-name $fn --region $Region }

    if ($existe) {
        if ($PSCmdlet.ShouldProcess($fn, 'actualizar')) {
            aws lambda update-function-code --function-name $fn --zip-file "fileb://$ZipPath" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Falló la actualización del código de $fn." }
            aws lambda wait function-updated --function-name $fn --region $Region | Out-Null
            aws lambda update-function-configuration `
                --function-name $fn --handler $ep.Handler --runtime $Runtime `
                --environment $envVars --timeout 10 `
                --region $Region | Out-Null
            aws lambda wait function-updated --function-name $fn --region $Region | Out-Null
            Write-Ok "actualizada: $fn"
        }
    } else {
        if ($PSCmdlet.ShouldProcess($fn, 'crear')) {
            aws lambda create-function `
                --function-name $fn `
                --runtime $Runtime `
                --handler $ep.Handler `
                --role $RoleArn `
                --zip-file "fileb://$ZipPath" `
                --timeout 10 `
                --environment $envVars `
                --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Falló la creación de $fn (¿existe el rol $RoleName?)." }
            aws lambda wait function-active-v2 --function-name $fn --region $Region | Out-Null
            Write-Ok "creada:      $fn"
        }
    }
}

# authorizer
Write-Step 'JWT authorizer (Entra ID)'
$authorizers = (aws apigatewayv2 get-authorizers --api-id $ApiId --region $Region | ConvertFrom-Json).Items
$authorizer = $authorizers | Where-Object {
    $existente = $_
    $_.AuthorizerType -eq 'JWT' -and
    ($Audiences | Where-Object { $existente.JwtConfiguration.Audience -contains $_ })
} | Select-Object -First 1

if ($authorizer) {
    $AuthorizerId = $authorizer.AuthorizerId
    $actuales = @($authorizer.JwtConfiguration.Audience)
    $faltan = @($Audiences | Where-Object { $actuales -notcontains $_ })
    if ($faltan.Count -eq 0) {
        Write-Skip "Reutilizando '$($authorizer.Name)' ($AuthorizerId), ya acepta las dos audiencias"
    } elseif ($PSCmdlet.ShouldProcess($authorizer.Name, 'agregar audiencias')) {
        # se suman a las que ya tiene, no se reemplazan
        $jwtFile = Write-JsonFile 'pedidos360-jwt.json' @{
            Issuer   = $authorizer.JwtConfiguration.Issuer
            Audience = @($actuales + $faltan)
        }
        aws apigatewayv2 update-authorizer `
            --api-id $ApiId --authorizer-id $AuthorizerId `
            --jwt-configuration "file://$jwtFile" --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Falló la actualización del authorizer $($authorizer.Name)." }
        Write-Ok "Audiencias agregadas a '$($authorizer.Name)': $($faltan -join ', ')"
    }
} elseif ($PSCmdlet.ShouldProcess('entra-jwt', 'crear authorizer')) {
    $jwtFile = Write-JsonFile 'pedidos360-jwt.json' @{
        Issuer   = "https://login.microsoftonline.com/$TenantId/v2.0"
        Audience = @($Audiences)
    }
    $creado = aws apigatewayv2 create-authorizer `
        --api-id $ApiId --name entra-jwt --authorizer-type JWT `
        --identity-source '$request.header.Authorization' `
        --jwt-configuration "file://$jwtFile" --region $Region | ConvertFrom-Json
    $AuthorizerId = $creado.AuthorizerId
    Write-Ok "Authorizer creado ($AuthorizerId)"
}

# integraciones y rutas
Write-Step 'Integraciones y rutas'
$integraciones = (aws apigatewayv2 get-integrations --api-id $ApiId --region $Region | ConvertFrom-Json).Items
$rutas = (aws apigatewayv2 get-routes --api-id $ApiId --region $Region | ConvertFrom-Json).Items

foreach ($ep in $Endpoints) {
    $fn = "$Prefijo-$($ep.Nombre)"
    $fnArn = "arn:aws:lambda:${Region}:${AccountId}:function:$fn"

    # una integracion por funcion
    $integracion = $integraciones | Where-Object { $_.IntegrationUri -eq $fnArn } | Select-Object -First 1
    if ($integracion) {
        $integracionId = $integracion.IntegrationId
    } elseif ($PSCmdlet.ShouldProcess($fn, 'crear integración')) {
        $creada = aws apigatewayv2 create-integration `
            --api-id $ApiId --integration-type AWS_PROXY --integration-uri $fnArn `
            --payload-format-version '2.0' --region $Region | ConvertFrom-Json
        $integracionId = $creada.IntegrationId
    }

    # la ruta se crea, o se corrige si apunta a otra lambda o le falta el scope
    $ruta = $rutas | Where-Object { $_.RouteKey -eq $ep.Ruta } | Select-Object -First 1
    if ($ruta) {
        $apuntaBien = $ruta.Target -eq "integrations/$integracionId"
        $scopeBien = (@($ruta.AuthorizationScopes) -join ' ') -eq $ep.Scope
        if ($apuntaBien -and $scopeBien) {
            Write-Skip "ya está bien: $($ep.Ruta)  [$($ep.Scope)]"
        } elseif ($PSCmdlet.ShouldProcess($ep.Ruta, 'corregir destino y scope')) {
            aws apigatewayv2 update-route `
                --api-id $ApiId --route-id $ruta.RouteId `
                --target "integrations/$integracionId" `
                --authorization-type JWT --authorizer-id $AuthorizerId `
                --authorization-scopes $ep.Scope `
                --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Falló la actualización de la ruta $($ep.Ruta)." }
            Write-Ok "actualizada: $($ep.Ruta)  ->  $fn  [$($ep.Scope)]"
        }
    } elseif ($PSCmdlet.ShouldProcess($ep.Ruta, 'crear ruta')) {
        aws apigatewayv2 create-route `
            --api-id $ApiId --route-key $ep.Ruta `
            --target "integrations/$integracionId" `
            --authorization-type JWT --authorizer-id $AuthorizerId `
            --authorization-scopes $ep.Scope `
            --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Falló la creación de la ruta $($ep.Ruta)." }
        Write-Ok "creada:      $($ep.Ruta)  ->  $fn  [$($ep.Scope)]"
    }
}

# el cors va en el api y no en el codigo
# el preflight OPTIONS viaja sin token, asi que si lo protege el authorizer
# muere en 401 y el navegador bloquea todo
Write-Step 'CORS del API'
if ($PSCmdlet.ShouldProcess($ApiId, 'configurar CORS')) {
    $corsFile = Write-JsonFile 'pedidos360-cors.json' @{
        AllowOrigins = @($AllowedOrigin)
        AllowMethods = @('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')
        AllowHeaders = @('authorization', 'content-type')
        MaxAge       = 3600
    }
    aws apigatewayv2 update-api --api-id $ApiId --cors-configuration "file://$corsFile" --region $Region | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "Origen permitido: $AllowedOrigin" }
    else { throw 'Falló la actualización de CORS (revisa el error de arriba).' }
}

# permisos para que el api gateway pueda invocar las lambdas
Write-Step 'Permisos para que API Gateway invoque las Lambdas'
$agregados = 0
foreach ($ep in $Endpoints) {
    $fn = "$Prefijo-$($ep.Nombre)"
    if ($PSCmdlet.ShouldProcess($fn, 'permitir invocación')) {
        $ok = Test-AwsSuccess {
            aws lambda add-permission `
                --function-name $fn --statement-id "apigw-$ApiId" `
                --action lambda:InvokeFunction --principal apigateway.amazonaws.com `
                --source-arn "arn:aws:execute-api:${Region}:${AccountId}:$ApiId/*/*" `
                --region $Region
        }
        if ($ok) { $agregados++ }
    }
}
Write-Ok "$agregados permiso(s) agregado(s); el resto ya los tenía"

# ======================= mensajeria =======================
# todo sale de infra/mensajeria.json; igual que con las rutas, se crea lo que
# falta y se corrige lo que no calza, asi lo hecho en la consola se respeta

function Get-QueueUrl([string]$Nombre) {
    if (-not (Test-AwsSuccess { aws sqs get-queue-url --queue-name $Nombre --region $Region })) { return $null }
    return aws sqs get-queue-url --queue-name $Nombre --region $Region --query QueueUrl --output text
}

function Get-QueueAttrs([string]$Url) {
    return (aws sqs get-queue-attributes --queue-url $Url --attribute-names All --region $Region | ConvertFrom-Json).Attributes
}

Write-Step 'Topic SNS (estándar)'
if (Test-AwsSuccess { aws sns get-topic-attributes --topic-arn $TopicArn --region $Region }) {
    Write-Skip "ya existe: $($Mensajeria.topic)"
} elseif ($PSCmdlet.ShouldProcess($Mensajeria.topic, 'crear topic')) {
    aws sns create-topic --name $Mensajeria.topic --region $Region | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el topic $($Mensajeria.topic)." }
    Write-Ok "creado:      $($Mensajeria.topic)"
}

Write-Step 'Colas SQS (cada una con su DLQ)'
$retencionDlq = [string]([int]$Mensajeria.retencionDlqDias * 86400)
$Colas = @{}
foreach ($c in $Mensajeria.consumidores) {
    # primero la dlq: la cola principal la necesita para su redrive policy
    $dlqUrl = Get-QueueUrl $c.dlq
    if (-not $dlqUrl) {
        if ($PSCmdlet.ShouldProcess($c.dlq, 'crear DLQ')) {
            $f = Write-JsonFile 'p360-attrs.json' @{ MessageRetentionPeriod = $retencionDlq }
            $dlqUrl = aws sqs create-queue --queue-name $c.dlq --attributes "file://$f" --region $Region --query QueueUrl --output text
            if ($LASTEXITCODE -ne 0) { throw "No se pudo crear la cola $($c.dlq)." }
            Write-Ok "creada:      $($c.dlq)"
        }
    } elseif ((Get-QueueAttrs $dlqUrl).MessageRetentionPeriod -ne $retencionDlq) {
        # la dlq guarda mas tiempo que la cola principal, para alcanzar a revisarla
        if ($PSCmdlet.ShouldProcess($c.dlq, "retención de $($Mensajeria.retencionDlqDias) días")) {
            $f = Write-JsonFile 'p360-attrs.json' @{ MessageRetentionPeriod = $retencionDlq }
            aws sqs set-queue-attributes --queue-url $dlqUrl --attributes "file://$f" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar la cola $($c.dlq)." }
            Write-Ok "actualizada: $($c.dlq)  (retención $($Mensajeria.retencionDlqDias) días)"
        }
    } else {
        Write-Skip "ya está bien: $($c.dlq)"
    }

    $dlqArn = "arn:aws:sqs:${Region}:${AccountId}:$($c.dlq)"
    $colaArn = "arn:aws:sqs:${Region}:${AccountId}:$($c.cola)"
    $redrive = @{ deadLetterTargetArn = $dlqArn; maxReceiveCount = [int]$Mensajeria.maxReceiveCount } | ConvertTo-Json -Compress
    # sin este permiso el topic no puede escribir en la cola, y los mensajes
    # se pierden sin ningun error a la vista
    $politica = @{
        Version   = '2012-10-17'
        Statement = @(@{
            Sid       = "topic-$($Mensajeria.topic)"
            Effect    = 'Allow'
            Principal = @{ Service = 'sns.amazonaws.com' }
            Action    = 'sqs:SendMessage'
            Resource  = $colaArn
            Condition = @{ ArnEquals = @{ 'aws:SourceArn' = $TopicArn } }
        })
    } | ConvertTo-Json -Compress -Depth 10

    $url = Get-QueueUrl $c.cola
    if (-not $url) {
        if ($PSCmdlet.ShouldProcess($c.cola, 'crear cola')) {
            $f = Write-JsonFile 'p360-attrs.json' @{
                VisibilityTimeout = [string]$Mensajeria.visibilidadSegundos
                RedrivePolicy     = $redrive
                Policy            = $politica
            }
            aws sqs create-queue --queue-name $c.cola --attributes "file://$f" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo crear la cola $($c.cola)." }
            Write-Ok "creada:      $($c.cola)  ->  $($c.dlq)"
        }
    } else {
        $a = Get-QueueAttrs $url
        $cambios = @{}
        if ($a.VisibilityTimeout -ne [string]$Mensajeria.visibilidadSegundos) {
            $cambios.VisibilityTimeout = [string]$Mensajeria.visibilidadSegundos
        }
        $actual = if ($a.RedrivePolicy) { $a.RedrivePolicy | ConvertFrom-Json } else { $null }
        if (-not $actual -or $actual.deadLetterTargetArn -ne $dlqArn -or
            [int]$actual.maxReceiveCount -ne [int]$Mensajeria.maxReceiveCount) {
            $cambios.RedrivePolicy = $redrive
        }
        if (-not ($a.Policy -and $a.Policy -like "*$TopicArn*" -and $a.Policy -like '*sqs:SendMessage*')) {
            $cambios.Policy = $politica
        }
        if ($cambios.Count -eq 0) {
            Write-Skip "ya está bien: $($c.cola)  ->  $($c.dlq)"
        } elseif ($PSCmdlet.ShouldProcess($c.cola, "corregir $($cambios.Keys -join ', ')")) {
            $f = Write-JsonFile 'p360-attrs.json' $cambios
            aws sqs set-queue-attributes --queue-url $url --attributes "file://$f" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar la cola $($c.cola)." }
            Write-Ok "actualizada: $($c.cola)  ($($cambios.Keys -join ', '))"
        }
    }
    $Colas[$c.cola] = $colaArn
}

Write-Step 'Suscripciones del topic (filtro + entrega sin procesar)'
$subs = @()
if (Test-AwsSuccess { aws sns get-topic-attributes --topic-arn $TopicArn --region $Region }) {
    $subs = @((aws sns list-subscriptions-by-topic --topic-arn $TopicArn --region $Region | ConvertFrom-Json).Subscriptions)
}
foreach ($c in $Mensajeria.consumidores) {
    $colaArn = $Colas[$c.cola]
    $filtro = $c.filtro | ConvertTo-Json -Compress -Depth 10
    $sub = $subs | Where-Object { $_.Endpoint -eq $colaArn } | Select-Object -First 1

    if (-not $sub) {
        if ($PSCmdlet.ShouldProcess($c.cola, 'suscribir al topic')) {
            $f = Write-JsonFile 'p360-sub.json' @{
                RawMessageDelivery = 'true'
                FilterPolicyScope  = 'MessageAttributes'
                FilterPolicy       = $filtro
            }
            aws sns subscribe --topic-arn $TopicArn --protocol sqs --notification-endpoint $colaArn `
                --attributes "file://$f" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo suscribir $($c.cola) al topic." }
            Write-Ok "suscrita:    $($c.cola)  $filtro"
        }
        continue
    }

    $a = (aws sns get-subscription-attributes --subscription-arn $sub.SubscriptionArn --region $Region | ConvertFrom-Json).Attributes
    $filtroActual = if ($a.FilterPolicy) { $a.FilterPolicy | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10 } else { '' }
    $cambios = [ordered]@{}
    if ($a.RawMessageDelivery -ne 'true') { $cambios.RawMessageDelivery = 'true' }
    if ($filtroActual -ne $filtro) { $cambios.FilterPolicy = $filtro }
    if ($a.FilterPolicyScope -and $a.FilterPolicyScope -ne 'MessageAttributes') { $cambios.FilterPolicyScope = 'MessageAttributes' }

    if ($cambios.Count -eq 0) {
        Write-Skip "ya está bien: $($c.cola)  $filtro"
    } elseif ($PSCmdlet.ShouldProcess($c.cola, "corregir $($cambios.Keys -join ', ')")) {
        foreach ($k in $cambios.Keys) {
            $f = Write-TextFile 'p360-valor.txt' $cambios[$k]
            aws sns set-subscription-attributes --subscription-arn $sub.SubscriptionArn `
                --attribute-name $k --attribute-value "file://$f" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar $k de la suscripción de $($c.cola)." }
        }
        Write-Ok "actualizada: $($c.cola)  ($($cambios.Keys -join ', '))"
    }
}

Write-Step 'Lambdas consumidoras (una por cola)'
foreach ($c in $Mensajeria.consumidores) {
    # cada consumidor recibe la url de su propia dlq; el script siempre deja
    # la caida simulada apagada
    $envFile = Write-JsonFile "p360-env-$($c.funcion).json" @{
        Variables = @{
            DLQ_URL              = [string](Get-QueueUrl $c.dlq)
            MAX_RECEIVE_COUNT    = [string]$Mensajeria.maxReceiveCount
            NOTIFICACIONES_TABLE = $Mensajeria.tablaNotificaciones
            SIMULAR_CAIDA        = 'false'
        }
    }
    $timeout = [string]$Mensajeria.timeoutConsumidorSegundos

    if (Test-AwsSuccess { aws lambda get-function --function-name $c.funcion --region $Region }) {
        if ($PSCmdlet.ShouldProcess($c.funcion, 'actualizar')) {
            aws lambda update-function-code --function-name $c.funcion --zip-file "fileb://$ZipPath" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Falló la actualización del código de $($c.funcion)." }
            aws lambda wait function-updated --function-name $c.funcion --region $Region | Out-Null
            aws lambda update-function-configuration `
                --function-name $c.funcion --handler $c.handler --runtime $Runtime `
                --environment "file://$envFile" --timeout $timeout --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Falló la configuración de $($c.funcion)." }
            aws lambda wait function-updated --function-name $c.funcion --region $Region | Out-Null
            Write-Ok "actualizada: $($c.funcion)  ($($c.dominio))"
        }
    } elseif ($PSCmdlet.ShouldProcess($c.funcion, 'crear')) {
        aws lambda create-function `
            --function-name $c.funcion --runtime $Runtime --handler $c.handler `
            --role $RoleArn --zip-file "fileb://$ZipPath" --timeout $timeout `
            --environment "file://$envFile" --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Falló la creación de $($c.funcion)." }
        aws lambda wait function-active-v2 --function-name $c.funcion --region $Region | Out-Null
        Write-Ok "creada:      $($c.funcion)  ($($c.dominio))"
    }
}

Write-Step 'Triggers SQS (informando errores por mensaje)'
$lote = [string]$Mensajeria.tamanoLote
foreach ($c in $Mensajeria.consumidores) {
    $colaArn = $Colas[$c.cola]
    if (-not (Test-AwsSuccess { aws lambda get-function --function-name $c.funcion --region $Region })) {
        Write-Skip "sin función todavía: $($c.funcion)"
        continue
    }
    $m = (aws lambda list-event-source-mappings --function-name $c.funcion --event-source-arn $colaArn `
        --region $Region | ConvertFrom-Json).EventSourceMappings | Select-Object -First 1

    # sin ReportBatchItemFailures lambda ignora los batchItemFailures del
    # codigo y borra el lote entero aunque un mensaje haya fallado
    if (-not $m) {
        if ($PSCmdlet.ShouldProcess("$($c.cola) -> $($c.funcion)", 'crear trigger')) {
            aws lambda create-event-source-mapping --function-name $c.funcion --event-source-arn $colaArn `
                --batch-size $lote --function-response-types ReportBatchItemFailures --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo conectar $($c.cola) con $($c.funcion)." }
            Write-Ok "creado:      $($c.cola)  ->  $($c.funcion)"
        }
    } elseif ([string]$m.BatchSize -ne $lote -or $m.FunctionResponseTypes -notcontains 'ReportBatchItemFailures' -or
              $m.State -in @('Disabled', 'Disabling')) {
        # en aws academy, al terminar la sesion el LabRole pierde los permisos de
        # sqs y lambda apaga el trigger; al volver no se enciende solo. los
        # mensajes no se pierden: esperan en la cola hasta que se encienda
        if ($PSCmdlet.ShouldProcess("$($c.cola) -> $($c.funcion)", 'corregir y encender trigger')) {
            aws lambda update-event-source-mapping --uuid $m.UUID --enabled `
                --batch-size $lote --function-response-types ReportBatchItemFailures --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar el trigger de $($c.funcion)." }
            Write-Ok "actualizado: $($c.cola)  ->  $($c.funcion)  (lote $lote, errores por mensaje, activo)"
        }
    } else {
        Write-Skip "ya está bien: $($c.cola)  ->  $($c.funcion)"
    }
}

Write-Step 'Listo'
Write-Host "    Base URL: https://$ApiId.execute-api.$Region.amazonaws.com" -ForegroundColor Green
Write-Host "    Lambdas:  $($Endpoints.Count) (una por método y ruta)" -ForegroundColor Green
Write-Host "    Tablas:   $CatalogTable · $OrdersTable · $($Mensajeria.tablaNotificaciones)" -ForegroundColor Green
Write-Host "    Topic:    $($Mensajeria.topic) -> $(($Mensajeria.consumidores | ForEach-Object { $_.cola }) -join ', ')" -ForegroundColor Green
Write-Host "    Prueba:   corepack pnpm dev  ->  entra a /catalog y /orders`n"

# sin esto el script se queda con el codigo de salida del ultimo aws (254 si
# el permiso ya estaba) y parece que fallo aunque haya salido todo bien
exit 0
