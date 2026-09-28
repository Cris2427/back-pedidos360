# sube todo el backend a aws: una lambda por metodo y ruta
#
#   1. crea las dos tablas de dynamodb y llena el catalogo si esta vacio
#   2. empaqueta el codigo (handlers y lib) en un zip
#   3. crea o actualiza las 10 funciones, cada una con su handler
#   4. reusa el authorizer que ya existe, o crea uno
#   5. crea una integracion por funcion
#   6. crea las 10 rutas o las reapunta si ya estaban
#   7. configura el cors del api
#   8. le da permiso al api gateway para invocar cada funcion
#
# las rutas se agregan al api que ya existe sin cambiarle la url, asi el .env
# del front no se toca
# se puede correr las veces que sea, no duplica nada
#
# necesita el aws cli configurado
# en aws academy las credenciales se vencen, si sale ExpiredToken hay que
# recargarlas desde AWS Details
#
# uso:
#   powershell -File infra\deploy-aws.ps1 -WhatIf   # muestra que haria
#   powershell -File infra\deploy-aws.ps1

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
    [string]$RoleName      = 'LabRole'
)

$ErrorActionPreference = 'Stop'

# las 10 lambdas, una por metodo y ruta
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

# el aws cli no soporta el BOM al inicio de un archivo de parametros, y
# Set-Content -Encoding utf8 siempre lo agrega, por eso usamos WriteAllText
function Write-JsonFile {
    param([string]$Name, $Value)
    $path = Join-Path $env:TEMP $Name
    [System.IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Compress -Depth 10))
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
foreach ($carpeta in @('handlers', 'lib')) {
    if (-not (Test-Path (Join-Path $SourceDir $carpeta))) {
        throw "No se encontró la carpeta $carpeta en $SourceDir"
    }
}
$fuentes = @('handlers', 'lib') | ForEach-Object { Join-Path $SourceDir $_ }
# -Force pisa el zip anterior
# no usamos Remove-Item porque respeta -WhatIf y Compress-Archive no, asi que
# en el ensayo quedaba el archivo viejo y fallaba
Compress-Archive -Path $fuentes -DestinationPath $ZipPath -Force
Write-Ok "Zip listo: $ZipPath"

# las funciones
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

    # la ruta se crea, o se reapunta si ya existia
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

Write-Step 'Listo'
Write-Host "    Base URL: https://$ApiId.execute-api.$Region.amazonaws.com" -ForegroundColor Green
Write-Host "    Lambdas:  $($Endpoints.Count) (una por método y ruta)" -ForegroundColor Green
Write-Host "    Tablas:   $CatalogTable · $OrdersTable" -ForegroundColor Green
Write-Host "    Prueba:   corepack pnpm dev  ->  entra a /catalog y /orders`n"

# sin esto el script se queda con el codigo de salida del ultimo aws (254 si
# el permiso ya estaba) y parece que fallo aunque haya salido todo bien
exit 0
