using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DataCentral.AppStarter.Api.Models;
using DataCentral.AppStarter.Api.Options;
using Microsoft.Extensions.Options;

namespace DataCentral.AppStarter.Api.Services;

public sealed class DataCentralLaunchVerifier : IDataCentralLaunchVerifier
{
    private readonly DataCentralLaunchOptions _options;

    public DataCentralLaunchVerifier(IOptions<DataCentralLaunchOptions> options)
    {
        _options = options.Value;
    }

    public DataCentralUserContext? VerifyFromHeaders(IHeaderDictionary headers)
    {
        var dcdata = headers["X-DC-Data"].FirstOrDefault();
        var dcsig = headers["X-DC-Sig"].FirstOrDefault();

        if (string.IsNullOrWhiteSpace(dcdata) || string.IsNullOrWhiteSpace(dcsig))
            return null;

        if (!VerifySignature(dcdata, dcsig))
            return null;

        var legacy = DecodePayload(dcdata);
        return Normalize(legacy, isVerified: true);
    }

    public bool HasRole(DataCentralUserContext? context, string role)
    {
        return context?.Roles.Any(r => string.Equals(r, role, StringComparison.OrdinalIgnoreCase)) == true;
    }

    private bool VerifySignature(string dcdata, string dcsig)
    {
        if (string.IsNullOrWhiteSpace(_options.AppSecret))
            return false;

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_options.AppSecret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(dcdata));
        var computed = Convert.ToBase64String(hash);

        var a = Encoding.UTF8.GetBytes(computed);
        var b = Encoding.UTF8.GetBytes(dcsig);

        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static LegacyDcData DecodePayload(string dcdata)
    {
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(dcdata));
        using var doc = JsonDocument.Parse(json);

        if (doc.RootElement.ValueKind == JsonValueKind.String)
        {
            json = doc.RootElement.GetString() ?? "{}";
        }

        return JsonSerializer.Deserialize<LegacyDcData>(
            json,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
        ) ?? new LegacyDcData();
    }

    private static DataCentralUserContext Normalize(LegacyDcData data, bool isVerified)
    {
        return new DataCentralUserContext
        {
            IsVerified = isVerified,
            User = new DataCentralUserContext.UserContext
            {
                Id = data.UserId.ToString(),
                UserName = data.UserName,
                DisplayName = string.IsNullOrWhiteSpace(data.UserDisplayName)
                    ? data.UserName
                    : data.UserDisplayName
            },
            Tenant = new DataCentralUserContext.TenantContext
            {
                Id = data.TenantId.ToString(),
                Name = data.TenancyName,
                ClientUrl = data.ClientUrl
            },
            Roles = data.RoleDisplayNames,
            RoleIds = data.RoleIds.Select(x => x.ToString()).ToList(),
            IssuedAt = data.TimeStamp
        };
    }
}
