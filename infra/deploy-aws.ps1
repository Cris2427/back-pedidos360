# infra/deploy-aws.ps1
#
# Despliega el backend de Pedidos360 en AWS: UNA LAMBDA POR MÉTODO Y RUTA.
#
#   1. Crea las dos tablas de DynamoDB (si no existen) y siembra el catálogo
#   2. Empaqueta el código una vez (handlers/ + lib/)
#   3. Crea o actualiza las 10 funciones Lambda, cada una con su handler
#   4. Reutiliza el JWT authorizer existente, o crea uno con tu tenant
#   5. Crea una integración por función
#   6. Crea o reapunta las 10 rutas, todas con el authorizer
#   7. Configura CORS a nivel de API (el preflight OPTIONS no lleva token)
#   8. Le da permiso al API Gateway para invocar cada función
#
# AGREGA las rutas al HTTP API que ya tienes sin cambiar su URL, así que el
# .env del frontend no se toca. Es idempotente: se puede correr muchas veces.
#
# Requisitos: AWS CLI v2 configurado. En AWS Academy las credenciales caducan:
# recárgalas desde AWS Details cuando veas "ExpiredToken".
#
# Uso:
#   powershell -File infra\deploy-aws.ps1 -WhatIf   # muestra qué haría
#   powershell -File infra\deploy-aws.ps1

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Region        = 'us-east-1',
    [string]$ApiId         = '5hnna48kv8',
    [string]$Prefijo       = 'pedidos360',
    [string]$CatalogTable  = 'Pedidos360-Catalog',
    [string]$OrdersTable   = 'Pedidos360-Orders',
    [string]$TenantId      = '20d60927-bff9-498f-8c5b-94db0ccba634',
    # Las dos formas del claim `aud`: los tokens v2 de Entra lo emiten como el
    # client ID pelado y los v1 como el App ID URI. El authorizer compara
    # literal, así que se aceptan ambas.
    [string[]]$Audiences   = @(
        '4af5ea55-a655-4bcb-b24c-9e315b1ee75c',
        'api://4af5ea55-a655-4bcb-b24c-9e315b1ee75c'
    ),
    [string]$AllowedOrigin = 'http://localhost:5173',
    # Rol de ejecución. En AWS Academy es 'LabRole'. Necesita
    # AWSLambdaBasicExecutionRole + acceso a DynamoDB sobre las dos tablas.
    [string]$RoleName      = 'LabRole'
)

$ErrorActionPreference = 'Stop'

# --- Las 10 Lambdas: una por método y ruta ---------------------------------
$Endpoints = @(
    @{ Nombre = 'catalog-get';       Handler = 'handlers/catalog-get.handler';        Ruta = 'GET /api/catalog' }
    @{ Nombre = 'catalog-post';      Handler = 'handlers/catalog-post.handler';       Ruta = 'POST /api/catalog' }
    @{ Nombre = 'catalog-put';       Handler = 'handlers/catalog-put.handler';        Ruta = 'PUT /api/catalog/{id}' }
    @{ Nombre = 'catalog-stock-put'; Handler = 'handlers/catalog-stock-put.handler';  Ruta = 'PUT /api/catalog/{id}/stock' }
    @{ Nombre = 'catalog-delete';    Handler = 'handlers/catalog-delete.handler';     Ruta = 'DELETE /api/catalog/{id}' }
    @{ Nombre = 'orders-get';        Handler = 'handlers/orders-get.handler';         Ruta = 'GET /api/orders' }
    @{ Nombre = 'orders-post';       Handler = 'handlers/orders-post.handler';        Ruta = 'POST /api/orders' }
    @{ Nombre = 'orders-put';        Handler = 'handlers/orders-put.handler';         Ruta = 'PUT /api/orders/{id}' }
    @{ Nombre = 'orders-status';     Handler = 'handlers/orders-status-patch.handler'; Ruta = 'PATCH /api/orders/{id}/status' }
    @{ Nombre = 'orders-delete';     Handler = 'handlers/orders-delete.handler';      Ruta = 'DELETE /api/orders/{id}' }
)

function Write-Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Skip($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# El AWS CLI no tolera un BOM al inicio de un archivo de parámetros, y
# Set-Content -Encoding utf8 en PowerShell 5.1 siempre lo agrega.
function Write-JsonFile {
    param([string]$Name, $Value)
    $path = Join-Path $env:TEMP $Name
    [System.IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Compress -Depth 10))
    return $path
}

# Los comandos nativos (aws.exe) NO lanzan excepciones al fallar: hay que
# mirar $LASTEXITCODE. Por eso este helper y no un try/catch.
function Test-AwsSuccess {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $Command *> $null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $previous
    return $ok
}

# --- 0. Comprobaciones previas ---------------------------------------------
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

# El codigo puede estar en dos sitios segun como se organice el repositorio:
#   - en la raiz, si el backend vive en su propio repo (handlers/ junto a infra/)
#   - bajo backend/pedidos360-api, si todo comparte una sola carpeta
# Se prueban los dos para que mover las carpetas no rompa el despliegue.
$SourceDir = @($RepoRoot, (Join-Path $RepoRoot 'backend/pedidos360-api')) |
    Where-Object { Test-Path (Join-Path $_ 'handlers') } |
    Select-Object -First 1

if (-not $SourceDir) {
    throw "No se encontro la carpeta handlers/ ni en $RepoRoot ni en $RepoRootackend\pedidos360-api."
}

# --- 1. Tablas de DynamoDB --------------------------------------------------
Write-Step 'Tablas de DynamoDB'
foreach ($table in @($CatalogTable, $OrdersTable)) {
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

# --- 2. Sembrar el catálogo (solo si está vacío) ----------------------------
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

# --- 3. Empaquetar ----------------------------------------------------------
# Un solo zip para las 10 funciones: cada una apunta a un handler distinto
# dentro de él. Comparten el código común de lib/ sin duplicarlo.
Write-Step 'Empaquetando el código'
foreach ($carpeta in @('handlers', 'lib')) {
    if (-not (Test-Path (Join-Path $SourceDir $carpeta))) {
        throw "No se encontró la carpeta $carpeta en $SourceDir"
    }
}
$fuentes = @('handlers', 'lib') | ForEach-Object { Join-Path $SourceDir $_ }
# -Force sobrescribe un zip anterior. No usamos Remove-Item porque respeta
# -WhatIf (no borraría) y Compress-Archive no lo respeta (sí escribiría).
Compress-Archive -Path $fuentes -DestinationPath $ZipPath -Force
Write-Ok "Zip listo: $ZipPath"

# --- 4. Las 10 funciones ----------------------------------------------------
Write-Step 'Funciones Lambda (una por método y ruta)'
$envVars = "Variables={ALLOWED_ORIGIN=$AllowedOrigin,CATALOG_TABLE=$CatalogTable,ORDERS_TABLE=$OrdersTable}"

foreach ($ep in $Endpoints) {
    $fn = "$Prefijo-$($ep.Nombre)"
    $existe = Test-AwsSuccess { aws lambda get-function --function-name $fn --region $Region }

    if ($existe) {
        if ($PSCmdlet.ShouldProcess($fn, 'actualizar')) {
            aws lambda update-function-code --function-name $fn --zip-file "fileb://$ZipPath" --region $Region | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Falló la actualización del código de $fn." }
            aws lambda wait function-updated --function-name $fn --region $Region | Out-Null
            aws lambda update-function-configuration `
                --function-name $fn --handler $ep.Handler --environment $envVars --timeout 10 `
                --region $Region | Out-Null
            aws lambda wait function-updated --function-name $fn --region $Region | Out-Null
            Write-Ok "actualizada: $fn"
        }
    } else {
        if ($PSCmdlet.ShouldProcess($fn, 'crear')) {
            aws lambda create-function `
                --function-name $fn `
                --runtime nodejs20.x `
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

# --- 5. JWT authorizer ------------------------------------------------------
Write-Step 'JWT authorizer (Entra ID)'
$authorizers = (aws apigatewayv2 get-authorizers --api-id $ApiId --region $Region | ConvertFrom-Json).Items
$authorizer = $authorizers | Where-Object {
    $existente = $_
    $_.AuthorizerType -eq 'JWT' -and
    ($Audiences | Where-Object { $existente.JwtConfiguration.Audience -contains $_ })
} | Select-Object -First 1

if ($authorizer) {
    $AuthorizerId = $authorizer.AuthorizerId
    Write-Skip "Reutilizando '$($authorizer.Name)' ($AuthorizerId)"
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

# --- 6. Integraciones y rutas ----------------------------------------------
Write-Step 'Integraciones y rutas'
$integraciones = (aws apigatewayv2 get-integrations --api-id $ApiId --region $Region | ConvertFrom-Json).Items
$rutas = (aws apigatewayv2 get-routes --api-id $ApiId --region $Region | ConvertFrom-Json).Items

foreach ($ep in $Endpoints) {
    $fn = "$Prefijo-$($ep.Nombre)"
    $fnArn = "arn:aws:lambda:${Region}:${AccountId}:function:$fn"

    # Una integración por función
    $integracion = $integraciones | Where-Object { $_.IntegrationUri -eq $fnArn } | Select-Object -First 1
    if ($integracion) {
        $integracionId = $integracion.IntegrationId
    } elseif ($PSCmdlet.ShouldProcess($fn, 'crear integración')) {
        $creada = aws apigatewayv2 create-integration `
            --api-id $ApiId --integration-type AWS_PROXY --integration-uri $fnArn `
            --payload-format-version '2.0' --region $Region | ConvertFrom-Json
        $integracionId = $creada.IntegrationId
    }

    # La ruta: se crea, o se reapunta si ya existía (p. ej. apuntando a la
    # Lambda monolítica anterior).
    $ruta = $rutas | Where-Object { $_.RouteKey -eq $ep.Ruta } | Select-Object -First 1
    if ($ruta) {
        if ($ruta.Target -eq "integrations/$integracionId") {
            Write-Skip "ya apunta bien: $($ep.Ruta)"
        } elseif ($PSCmdlet.ShouldProcess($ep.Ruta, 'reapuntar a su propia Lambda')) {
            aws apigatewayv2 update-route `
                --api-id $ApiId --route-id $ruta.RouteId `
                --target "integrations/$integracionId" `
                --authorization-type JWT --authorizer-id $AuthorizerId `
                --region $Region | Out-Null
            Write-Ok "reapuntada:  $($ep.Ruta)  ->  $fn"
        }
    } elseif ($PSCmdlet.ShouldProcess($ep.Ruta, 'crear ruta')) {
        aws apigatewayv2 create-route `
            --api-id $ApiId --route-key $ep.Ruta `
            --target "integrations/$integracionId" `
            --authorization-type JWT --authorizer-id $AuthorizerId `
            --region $Region | Out-Null
        Write-Ok "creada:      $($ep.Ruta)  ->  $fn"
    }
}

# --- 7. CORS ----------------------------------------------------------------
# Se configura en el API, no en el código: el preflight OPTIONS viaja sin
# header Authorization, así que el authorizer lo rechazaría con 401.
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

# --- 8. Permisos de invocación ----------------------------------------------
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

Write-Step 'Listo'
Write-Host "    Base URL: https://$ApiId.execute-api.$Region.amazonaws.com" -ForegroundColor Green
Write-Host "    Lambdas:  $($Endpoints.Count) (una por método y ruta)" -ForegroundColor Green
Write-Host "    Tablas:   $CatalogTable · $OrdersTable" -ForegroundColor Green
Write-Host "    Prueba:   corepack pnpm dev  ->  entra a /catalog y /orders`n"

# Sin esto el script hereda el código de salida del último `aws` (254 cuando un
# permiso ya existía) y parece que falló aunque todo haya terminado bien.
exit 0
