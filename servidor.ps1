# ==========================================================================
# ARQUIVO: servidor.ps1
# DESCRIÇÃO: Servidor HTTP local mínimo (sem dependências) para o Chess Analysis.
# Por que existe: o Stockfish roda em Web Worker e carrega um arquivo .wasm.
# Navegadores bloqueiam esses recursos quando a página é aberta como arquivo
# local (file://). Servir a pasta em http://localhost resolve isso.
#
# USO: dê duplo clique em iniciar.bat (ou execute este script).
# Para encerrar: feche esta janela ou pressione Ctrl+C.
# ==========================================================================

param(
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.wasm' = 'application/wasm'
    '.pgn'  = 'application/x-chess-pgn; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

function Send-Response {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$StatusText,
        [byte[]]$Body,
        [string]$ContentType
    )
    if ($null -eq $Body) { $Body = [byte[]]@() }
    $header = "HTTP/1.1 $StatusCode $StatusText`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($Body.Length)`r`n" +
              "Cache-Control: no-store`r`n" +
              "Access-Control-Allow-Origin: *`r`n" +
              "Access-Control-Allow-Methods: GET,OPTIONS`r`n" +
              "Access-Control-Allow-Headers: Content-Type`r`n" +
              "Access-Control-Max-Age: 86400`r`n" +
              "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
}

function Send-ApiJson {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$StatusText,
        [hashtable]$Payload
    )
    $json = ConvertTo-Json -InputObject $Payload -Compress -Depth 5
    Send-Response -Stream $Stream -StatusCode $StatusCode -StatusText $StatusText `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) `
        -ContentType 'application/json; charset=utf-8'
}

function Invoke-ApiUpstream {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [string]$Uri,
        [string]$Accept
    )
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $request = $null
    $response = $null
    $client.Timeout = [TimeSpan]::FromSeconds(15)

    try {
        $request = New-Object System.Net.Http.HttpRequestMessage(
            [System.Net.Http.HttpMethod]::Get, $Uri
        )
        $null = $request.Headers.TryAddWithoutValidation(
            'User-Agent', 'Acervo64/1.0 (+https://chessanalysis-murex.vercel.app)'
        )
        $request.Headers.Accept.ParseAdd($Accept)
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $contentType = ''
        if ($response.Content.Headers.ContentType) {
            $contentType = $response.Content.Headers.ContentType.MediaType
        }

        if ($contentType -eq 'text/html') {
            Send-ApiJson -Stream $Stream -StatusCode 502 -StatusText 'Bad Gateway' -Payload @{
                error = 'A API de origem retornou HTML em vez de dados. A requisição pode ter sido bloqueada.'
                code = 'blocked'
            }
            return
        }
        if (-not $response.IsSuccessStatusCode) {
            if ($status -eq 404) {
                Send-ApiJson -Stream $Stream -StatusCode 404 -StatusText 'Not Found' -Payload @{
                    error = 'Usuário não encontrado na fonte.'
                    code = 'not_found'
                }
            } elseif ($status -eq 429) {
                Send-ApiJson -Stream $Stream -StatusCode 429 -StatusText 'Too Many Requests' -Payload @{
                    error = 'A API pediu uma pausa. Aguarde e tente novamente.'
                    code = 'rate_limited'
                }
            } elseif ($status -ge 500) {
                Send-ApiJson -Stream $Stream -StatusCode 502 -StatusText 'Bad Gateway' -Payload @{
                    error = 'A API de origem falhou. Tente novamente em instantes.'
                    code = 'upstream'
                    upstreamStatus = $status
                }
            } else {
                Send-ApiJson -Stream $Stream -StatusCode $status -StatusText 'Upstream Error' -Payload @{
                    error = 'A API de origem recusou a requisição.'
                    code = 'blocked'
                }
            }
            return
        }

        if ($contentType) { $contentType = $response.Content.Headers.ContentType.ToString() }
        else { $contentType = 'application/octet-stream' }
        $body = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        Send-Response -Stream $Stream -StatusCode 200 -StatusText 'OK' -Body $body -ContentType $contentType
    } catch {
        if ($_.Exception -is [System.OperationCanceledException]) {
            Send-ApiJson -Stream $Stream -StatusCode 504 -StatusText 'Gateway Timeout' -Payload @{
                error = 'A consulta demorou demais e foi interrompida.'
                code = 'timeout'
            }
        } else {
            Send-ApiJson -Stream $Stream -StatusCode 502 -StatusText 'Bad Gateway' -Payload @{
                error = 'Não foi possível falar com o servidor de origem.'
                code = 'network'
            }
        }
    } finally {
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
        $client.Dispose()
    }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try {
    $listener.Start()
} catch {
    Write-Host "Nao foi possivel abrir a porta $Port. Feche outra janela do servidor e tente novamente." -ForegroundColor Red
    Read-Host "Pressione Enter para sair"
    exit 1
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  Acervo 64 - servidor local" -ForegroundColor Cyan
Write-Host "  Abra: $url" -ForegroundColor Green
Write-Host "  Para encerrar: Ctrl+C ou feche esta janela." -ForegroundColor DarkGray
Write-Host ""

Start-Sleep -Milliseconds 400
Start-Process $url

while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $null
    try {
        $client.ReceiveTimeout = 5000
        $stream = $client.GetStream()
        $stream.ReadTimeout = 5000

        $buffer = New-Object byte[] 16384
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { continue }

        $requestText = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        $firstLine = ($requestText -split "`r`n")[0]
        $requestParts = $firstLine -split ' '
        if ($requestParts.Length -lt 2) {
            Send-Response -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Body ([System.Text.Encoding]::UTF8.GetBytes('Bad request')) -ContentType 'text/plain'
            continue
        }

        $method = $requestParts[0]
        $target = $requestParts[1]

        $requestUri = [System.Uri]::new("http://localhost$target")
        $apiPath = $requestUri.AbsolutePath
        if ($apiPath -eq '/api/chesscom' -or $apiPath -eq '/api/lichess') {
            if ($method -eq 'OPTIONS') {
                Send-Response -Stream $stream -StatusCode 204 -StatusText 'No Content' `
                    -Body ([byte[]]@()) -ContentType 'application/json; charset=utf-8'
                continue
            }
            if ($method -ne 'GET') {
                Send-ApiJson -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' -Payload @{
                    error = 'Use GET.'
                }
                continue
            }

            $queryParams = @{}
            foreach ($pair in ($requestUri.Query.TrimStart('?') -split '&')) {
                if (-not $pair) { continue }
                $parts = $pair -split '=', 2
                $key = [System.Uri]::UnescapeDataString($parts[0].Replace('+', ' '))
                $value = ''
                if ($parts.Length -gt 1) {
                    $value = [System.Uri]::UnescapeDataString($parts[1].Replace('+', ' '))
                }
                $queryParams[$key] = $value
            }

            $username = [string]$queryParams['username']
            if ($apiPath -eq '/api/chesscom') {
                if ($username -notmatch '^[a-z0-9][a-z0-9_-]{2,24}$') {
                    Send-ApiJson -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Payload @{
                        error = 'Nome de usuário inválido para o Chess.com.'
                        code = 'invalid_username'
                    }
                    continue
                }
                $encodedUsername = [System.Uri]::EscapeDataString($username)
                $month = [string]$queryParams['month']
                $accept = 'application/json'
                $upstreamUrl = "https://api.chess.com/pub/player/$encodedUsername/games/archives"
                if ($queryParams.ContainsKey('month')) {
                    if ($month -notmatch '^(\d{4})-(0[1-9]|1[0-2])$') {
                        Send-ApiJson -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Payload @{
                            error = 'Mês inválido. Use o formato YYYY-MM.'
                            code = 'invalid_month'
                        }
                        continue
                    }
                    $upstreamUrl = "https://api.chess.com/pub/player/$encodedUsername/games/$($Matches[1])/$($Matches[2])/pgn"
                    $accept = 'application/x-chess-pgn'
                }
            } else {
                if ($username -notmatch '^[a-z0-9][a-z0-9_-]{1,29}$') {
                    Send-ApiJson -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Payload @{
                        error = 'Nome de usuário inválido para o Lichess.'
                        code = 'invalid_username'
                    }
                    continue
                }
                $encodedUsername = [System.Uri]::EscapeDataString($username)
                $query = New-Object System.Collections.Generic.List[string]
                if ($queryParams.ContainsKey('max')) {
                    $maxValue = 100.0
                    $parsedMax = 0.0
                    if ([double]::TryParse(
                        [string]$queryParams['max'],
                        [System.Globalization.NumberStyles]::Float,
                        [System.Globalization.CultureInfo]::InvariantCulture,
                        [ref]$parsedMax
                    )) {
                        $maxValue = [Math]::Min(100, [Math]::Max(1, [Math]::Round($parsedMax)))
                    }
                    $query.Add("max=$([int]$maxValue)")
                }
                $invalidPeriod = $false
                foreach ($name in @('since', 'until')) {
                    if (-not $queryParams.ContainsKey($name)) { continue }
                    $timestamp = 0L
                    if ($queryParams[$name] -notmatch '^\d+$' -or
                        -not [long]::TryParse([string]$queryParams[$name], [ref]$timestamp) -or
                        $timestamp -le 0) {
                        $invalidPeriod = $true
                        break
                    }
                    $query.Add("${name}=$timestamp")
                }
                if ($invalidPeriod) {
                    Send-ApiJson -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Payload @{
                        error = 'Período inválido.'
                        code = 'invalid_period'
                    }
                    continue
                }
                $suffix = ''
                if ($query.Count -gt 0) { $suffix = '?' + [string]::Join('&', $query) }
                $upstreamUrl = "https://lichess.org/api/games/user/$encodedUsername$suffix"
                $accept = 'application/x-chess-pgn'
            }

            Invoke-ApiUpstream -Stream $stream -Uri $upstreamUrl -Accept $accept
            continue
        }

        if ($method -ne 'GET' -and $method -ne 'HEAD') {
            Send-Response -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' -Body ([System.Text.Encoding]::UTF8.GetBytes('Method not allowed')) -ContentType 'text/plain'
            continue
        }

        $target = ($target -split '\?')[0]
        $target = [System.Uri]::UnescapeDataString($target)
        if ([string]::IsNullOrWhiteSpace($target) -or $target -eq '/') { $target = '/index.html' }

        $relative = $target.TrimStart('/') -replace '/', '\'
        $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        $rootPath = [System.IO.Path]::GetFullPath($root) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            Send-Response -Stream $stream -StatusCode 403 -StatusText 'Forbidden' -Body ([System.Text.Encoding]::UTF8.GetBytes('Acesso negado')) -ContentType 'text/plain; charset=utf-8'
            continue
        }

        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
            $contentType = $mime[$extension]
            if (-not $contentType) { $contentType = 'application/octet-stream' }
            if ($method -eq 'HEAD') { $bytes = [byte[]]@() }
            Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -Body $bytes -ContentType $contentType
        } else {
            $body = [System.Text.Encoding]::UTF8.GetBytes('Arquivo nao encontrado: ' + $relative)
            Send-Response -Stream $stream -StatusCode 404 -StatusText 'Not Found' -Body $body -ContentType 'text/plain; charset=utf-8'
        }
    } catch {
        # Conexões interrompidas pelo navegador são normais; siga em frente.
    } finally {
        if ($stream) { try { $stream.Close() } catch {} }
        try { $client.Close() } catch {}
    }
}
