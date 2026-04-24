using DataCentral.AppStarter.Api.Models;

namespace DataCentral.AppStarter.Api.Services;

public interface IDataCentralLaunchVerifier
{
    DataCentralUserContext? VerifyFromHeaders(IHeaderDictionary headers);
    bool HasRole(DataCentralUserContext? context, string role);
}
